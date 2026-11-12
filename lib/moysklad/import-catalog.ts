import type { Payload } from "payload"
import { extractMoyskladId } from "./client"
import { getMoyskladConfig } from "./config"
import { ensureMoyskladBundleForVariant, findMoyskladBundleByVariantId } from "./bundles"
import {
  fetchMoyskladAssortment,
  fetchMoyskladProductFolders,
  fetchMoyskladProducts,
  fetchMoyskladVariants,
  getPrimarySalePrice,
} from "./products"
import { getRelationshipId } from "@/lib/product-types"
import { slugify } from "@/lib/slug"
import type {
  MoyskladAssortment,
  MoyskladProduct,
  MoyskladProductFolder,
  MoyskladVariant,
} from "./types"
import type { ProductDetailsSchema } from "@/types"
import type { Category as PayloadCategoryDoc, Product as PayloadProductDoc, ProductType as PayloadProductTypeDoc } from "@/payload-types"

type Id = number

interface ImportStats {
  productTypesCreated: number
  productTypesUpdated: number
  productTypesDeleted: number
  categoriesCreated: number
  categoriesUpdated: number
  categoriesDeleted: number
  productsCreated: number
  productsUpdated: number
  productsHidden: number
  productsDeleted: number
  variantsImported: number
  variantsHidden: number
  clientCategoryDiscountsDeleted: number
  skippedProducts: string[]
}

function shortId(id?: string | null) {
  return id ? id.split("-")[0] : Math.random().toString(36).slice(2, 8)
}

function schemaForName(name: string): ProductDetailsSchema {
  const lower = name.toLowerCase()
  if (lower.includes("кофе") || lower.includes("эспрессо") || lower.includes("дрип")) return "coffee"
  if (lower.includes("чай")) return "tea"
  return "generic"
}

function getPinnedProductTypeSortOrder(name: string, slug: string) {
  const normalized = `${name} ${slug}`.toLowerCase()
  if (normalized.includes("кофе") || normalized.includes("coffee")) return 1
  if (normalized.includes("чай") || normalized.includes("tea")) return 2
  if (
    normalized.includes("аксессуар") ||
    normalized.includes("аксесуар") ||
    normalized.includes("accessor")
  ) {
    return 3
  }
  return null
}

function getFolderRootName(folder: MoyskladProductFolder) {
  const pathName = folder.pathName?.trim()
  if (!pathName) return folder.name || "Каталог"
  return pathName.split(/\s*\/\s*|\s*>\s*/)[0] || folder.name || "Каталог"
}

const EXCLUDED_ROOT_FOLDER_IDS = new Set([
  "a8efcb73-4f9b-11f1-0a80-1c98002087fe", // Служебное
  "adf79fb0-8ff2-11f1-0a80-1e92000d1e3c", // Оприходование и ТО (бывшая «поставщики»)
])

function isExcludedFolder(
  folder: MoyskladProductFolder,
  folderByFullName: Map<string, MoyskladProductFolder>
) {
  const rootFolder = folder.pathName ? folderByFullName.get(getFolderRootName(folder)) : folder
  const rootFolderId = getFolderId(rootFolder)
  return Boolean(rootFolderId && EXCLUDED_ROOT_FOLDER_IDS.has(rootFolderId))
}

function getFolderFullName(folder: MoyskladProductFolder) {
  return folder.pathName ? `${folder.pathName}/${folder.name}` : folder.name || ""
}

function getFolderDepth(folder: MoyskladProductFolder) {
  const fullName = getFolderFullName(folder)
  if (!fullName) return 0
  return fullName.split(/\s*\/\s*|\s*>\s*/).filter(Boolean).length - 1
}

function getFolderId(folder?: MoyskladProductFolder | null) {
  return folder?.id || extractMoyskladId(folder)
}

function getEntityId(entity?: MoyskladAssortment | MoyskladProduct | MoyskladVariant | null) {
  return entity?.id || extractMoyskladId(entity)
}

function getAssortmentStock(item?: MoyskladAssortment | MoyskladProduct | MoyskladVariant | null) {
  const stock = Number(item?.stock ?? 0)
  return Number.isFinite(stock) ? stock : 0
}

function getSyncedMoyskladId(doc: { moyskladId?: string | null }) {
  const id = doc.moyskladId?.trim()
  return id || null
}

function inferWeightGrams(name: string) {
  const kg = name.match(/(\d+(?:[.,]\d+)?)\s*кг/i)
  if (kg) return Math.round(Number(kg[1].replace(",", ".")) * 1000)

  const grams = name.match(/(\d+(?:[.,]\d+)?)\s*(?:гр\.?|г\.?|g|gr)(?=$|[\s,.;:)\]}-])/i)
  if (grams) return Math.round(Number(grams[1].replace(",", ".")))

  return null
}

function inferGrindOptions(name: string): ("beans" | "ground")[] {
  const lower = name.toLowerCase().replace(/ё/g, "е")
  if (lower.includes("молот")) return ["ground"]
  if (lower.includes("зерн")) return ["beans"]
  return []
}

function cleanVariantName(productName: string, variantName: string) {
  return variantName
    .replace(productName, "")
    .replace(/[()]/g, "")
    .replace(/^\s*[-–—,:]\s*/, "")
    .trim() || variantName
}

async function fetchAll<T>(
  fetcher: (limit: number, offset: number) => Promise<{ rows: T[]; meta: { size: number } }>,
  maxItems = 5000
) {
  const limit = 100
  const rows: T[] = []

  for (let offset = 0; offset < maxItems; offset += limit) {
    const batch = await fetcher(limit, offset)
    rows.push(...batch.rows)
    if (batch.rows.length < limit || rows.length >= batch.meta.size) break
  }

  return rows
}

async function findByMoyskladId<T extends { id: Id }>(
  payload: Payload,
  collection: "product-types" | "categories" | "products",
  moyskladId: string
) {
  const result = await payload.find({
    collection,
    where: { moyskladId: { equals: moyskladId } },
    limit: 1,
    depth: 0,
  })
  return (result.docs[0] as unknown as T | undefined) || null
}

async function findBySlug<T extends { id: Id }>(
  payload: Payload,
  collection: "product-types" | "categories" | "products",
  slug: string
) {
  const result = await payload.find({
    collection,
    where: { slug: { equals: slug } },
    limit: 1,
    depth: 0,
  })
  return (result.docs[0] as unknown as T | undefined) || null
}

async function hideExcludedCatalogEntries(params: {
  payload: Payload
  folders: MoyskladProductFolder[]
  products: MoyskladProduct[]
  folderById: Map<string, MoyskladProductFolder>
  folderByFullName: Map<string, MoyskladProductFolder>
  stats: ImportStats
}) {
  for (const folder of params.folders) {
    if (!isExcludedFolder(folder, params.folderByFullName)) continue

    const moyskladId = getFolderId(folder)
    if (!moyskladId) continue

    if (!folder.pathName) {
      const existing = await findByMoyskladId<PayloadProductTypeDoc>(params.payload, "product-types", moyskladId)
      if (!existing || existing.isVisible === false) continue

      await params.payload.update({
        collection: "product-types",
        id: existing.id,
        data: { isVisible: false },
      })
      params.stats.productTypesUpdated += 1
      continue
    }

    const existing = await findByMoyskladId<PayloadCategoryDoc>(params.payload, "categories", moyskladId)
    if (!existing || existing.isVisible === false) continue

    await params.payload.update({
      collection: "categories",
      id: existing.id,
      data: { isVisible: false },
    })
    params.stats.categoriesUpdated += 1
  }

  for (const product of params.products) {
    const productFolderId = extractMoyskladId(product.productFolder)
    const folder = productFolderId ? params.folderById.get(productFolderId) : null
    if (!folder || !isExcludedFolder(folder, params.folderByFullName)) continue

    const moyskladId = getEntityId(product)
    if (!moyskladId) continue

    const existing = await findByMoyskladId<PayloadProductDoc>(params.payload, "products", moyskladId)
    if (!existing || existing.isVisible === false) continue

    await params.payload.update({
      collection: "products",
      id: existing.id,
      data: { isVisible: false },
    })
    params.stats.productsHidden += 1
  }
}

async function getNextProductTypeSortOrder(payload: Payload) {
  const result = await payload.find({
    collection: "product-types",
    limit: 200,
    depth: 0,
  })
  const used = new Set(
    (result.docs as PayloadProductTypeDoc[])
      .map((doc) => Number(doc.sortOrder))
      .filter((value) => Number.isFinite(value) && value >= 4)
  )

  for (let order = 4; order < 1000; order += 1) {
    if (!used.has(order)) return order
  }

  return used.size + 4
}

async function upsertProductType(
  payload: Payload,
  folder: MoyskladProductFolder,
  rootName: string,
  stats: ImportStats
) {
  const moyskladId = folder.id || extractMoyskladId(folder)
  const slug = slugify(rootName, `type-${shortId(moyskladId)}`)
  const data = {
    name: rootName,
    slug,
    moyskladId,
    detailsSchema: schemaForName(rootName),
    isVisible: true,
  }

  const existing = moyskladId
    ? await findByMoyskladId<PayloadProductTypeDoc>(payload, "product-types", moyskladId)
    : await findBySlug<PayloadProductTypeDoc>(payload, "product-types", slug)

  if (existing) {
    const updated = await payload.update({
      collection: "product-types",
      id: existing.id,
      data,
    })
    stats.productTypesUpdated += 1
    return updated as PayloadProductTypeDoc
  }

  const pinnedSortOrder = getPinnedProductTypeSortOrder(rootName, slug)
  const created = await payload.create({
    collection: "product-types",
    data: {
      ...data,
      sortOrder: pinnedSortOrder ?? (await getNextProductTypeSortOrder(payload)),
    },
  })
  stats.productTypesCreated += 1
  return created as PayloadProductTypeDoc
}

async function upsertCategory(params: {
  payload: Payload
  folder: MoyskladProductFolder
  productType: PayloadProductTypeDoc
  parent?: PayloadCategoryDoc | null
  stats: ImportStats
}) {
  const moyskladId = params.folder.id || extractMoyskladId(params.folder)
  const baseSlug = slugify(
    `${params.productType.slug || params.productType.name}-${params.folder.name}`,
    `category-${shortId(moyskladId)}`
  )
  const data = {
    name: params.folder.name || "Категория",
    slug: baseSlug,
    moyskladId,
    productTypeRef: params.productType.id,
    parent: params.parent?.id || null,
    isVisible: true,
  }

  const existing = moyskladId
    ? await findByMoyskladId<PayloadCategoryDoc>(params.payload, "categories", moyskladId)
    : await findBySlug<PayloadCategoryDoc>(params.payload, "categories", baseSlug)

  if (existing) {
    const updated = await params.payload.update({
      collection: "categories",
      id: existing.id,
      data,
    })
    params.stats.categoriesUpdated += 1
    return updated as PayloadCategoryDoc
  }

  const created = await params.payload.create({
    collection: "categories",
    data: {
      ...data,
      sortOrder: 0,
    },
  })
  params.stats.categoriesCreated += 1
  return created as PayloadCategoryDoc
}

async function deleteObsoleteCategories(
  payload: Payload,
  activeCategoryFolderIds: Set<string>,
  stats: ImportStats
) {
  const result = await payload.find({
    collection: "categories",
    limit: 500,
    depth: 0,
  })

  const categories = (result.docs as PayloadCategoryDoc[])
    .filter((category) => {
      const moyskladId = getSyncedMoyskladId(category)
      return !moyskladId || !activeCategoryFolderIds.has(moyskladId)
    })
    .sort((a, b) => {
      const aHasParent = a.parent !== undefined && a.parent !== null
      const bHasParent = b.parent !== undefined && b.parent !== null
      return Number(bHasParent) - Number(aHasParent) || Number(b.id) - Number(a.id)
    })

  await cleanupClientCategoryDiscounts(
    payload,
    new Set(categories.map((category) => String(category.id))),
    stats
  )

  for (const category of categories) {
    const moyskladId = getSyncedMoyskladId(category)
    if (moyskladId && activeCategoryFolderIds.has(moyskladId)) continue

    await payload.delete({
      collection: "categories",
      id: category.id,
    })
    stats.categoriesDeleted += 1
  }
}

async function cleanupClientCategoryDiscounts(
  payload: Payload,
  obsoleteCategoryIds: Set<string>,
  stats: ImportStats
) {
  if (obsoleteCategoryIds.size === 0) return

  const result = await payload.find({
    collection: "clients",
    limit: 1000,
    depth: 0,
  })

  for (const client of result.docs) {
    const discounts = client.categoryDiscounts || []
    if (discounts.length === 0) continue

    const filteredDiscounts = discounts.filter((discount) => {
      const categoryId = getRelationshipId(discount.category)
      return !categoryId || !obsoleteCategoryIds.has(String(categoryId))
    })

    if (filteredDiscounts.length === discounts.length) continue

    await payload.update({
      collection: "clients",
      id: client.id,
      data: { categoryDiscounts: filteredDiscounts },
    })
    stats.clientCategoryDiscountsDeleted += discounts.length - filteredDiscounts.length
  }
}

async function deleteObsoleteProducts(payload: Payload, validProductIds: Set<string>, stats: ImportStats) {
  const result = await payload.find({
    collection: "products",
    limit: 1000,
    depth: 0,
  })

  for (const product of result.docs as PayloadProductDoc[]) {
    const moyskladId = getSyncedMoyskladId(product)
    if (moyskladId && validProductIds.has(moyskladId)) continue

    await payload.delete({
      collection: "products",
      id: product.id,
    })
    stats.productsDeleted += 1
  }
}

async function deleteObsoleteProductTypes(
  payload: Payload,
  activeRootFolderIds: Set<string>,
  stats: ImportStats
) {
  const result = await payload.find({
    collection: "product-types",
    limit: 500,
    depth: 0,
  })

  for (const productType of result.docs as PayloadProductTypeDoc[]) {
    const moyskladId = getSyncedMoyskladId(productType)
    if (moyskladId && activeRootFolderIds.has(moyskladId)) continue

    await payload.delete({
      collection: "product-types",
      id: productType.id,
    })
    stats.productTypesDeleted += 1
  }
}

function variantPayloadFromMoysklad(
  item: MoyskladVariant | MoyskladProduct,
  productName: string,
  options: { isAvailableOverride?: boolean } = {}
) {
  const moyskladId = getEntityId(item)
  const name = item.meta?.type === "variant"
    ? cleanVariantName(productName, item.name || "Вариант")
    : "1 шт"
  const moyskladType: "variant" | "product" = item.meta?.type === "variant" ? "variant" : "product"

  return {
    name,
    sku: item.article || item.code || null,
    moyskladId,
    moyskladType,
    price: getPrimarySalePrice(item),
    weightGrams: inferWeightGrams(item.name || name),
    // 12.11.2026: доступность не зависит от остатков — показом управляет
    // только галочка «видим в каталоге» в админке.
    isAvailable: options.isAvailableOverride ?? true,
    grindOptions: inferGrindOptions(item.name || ""),
  }
}

function preserveVariantPackaging(
  variants: ReturnType<typeof variantPayloadFromMoysklad>[],
  existingVariants: PayloadProductDoc["variants"]
) {
  const existingByMoyskladId = new Map(
    (existingVariants || [])
      .filter((variant) => getSyncedMoyskladId(variant))
      .map((variant) => [getSyncedMoyskladId(variant), variant])
  )

  // Штрихкоды КофеСклад (EAN-13 с префиксом 200) принадлежат учёту обжарки:
  // импорт из МойСклад не затирает ни их, ни skuGround.
  const isCoffeeskladBarcode = (value?: string | null) => /^200\d{10}$/.test((value || "").trim())

  return variants.map((variant) => {
    const moyskladId = getSyncedMoyskladId(variant)
    const existing = moyskladId ? existingByMoyskladId.get(moyskladId) : undefined
    if (!existing) return variant

    const existingSkuGround = (existing as { skuGround?: string | null }).skuGround ?? null

    // Packaging belongs to the site. Keep its row identity and manually entered
    // values when replacing the array, even if MoySklad renames or reorders it.
    return {
      ...variant,
      id: existing.id,
      sku: isCoffeeskladBarcode(existing.sku) ? existing.sku : variant.sku,
      skuGround: existingSkuGround,
      shippingLengthCm: existing.shippingLengthCm ?? null,
      shippingWidthCm: existing.shippingWidthCm ?? null,
      shippingHeightCm: existing.shippingHeightCm ?? null,
      shippingWeightGrams: existing.shippingWeightGrams ?? null,
    }
  })
}

function getVariantGrindSortOrder(variant: ReturnType<typeof variantPayloadFromMoysklad>) {
  const grind = variant.grindOptions[0] || ""
  if (grind === "beans") return 0
  if (grind === "ground") return 1
  return 99
}


async function applyExistingBundlePrice(
  row: {
    source: MoyskladVariant | MoyskladProduct | MoyskladAssortment
    payload: ReturnType<typeof variantPayloadFromMoysklad>
  }
) {
  const variantId = getEntityId(row.source)
  if (!variantId || !row.payload.weightGrams) return row

  const bundle = await findMoyskladBundleByVariantId(variantId)
  const bundlePrice = bundle?.salePrices?.[0]?.value
  if (!bundlePrice) return row

  return {
    ...row,
    payload: {
      ...row.payload,
      price: Math.round(bundlePrice) / 100,
    },
  }
}

function compareImportedVariants(
  a: ReturnType<typeof variantPayloadFromMoysklad>,
  b: ReturnType<typeof variantPayloadFromMoysklad>
) {
  const aWeight = a.weightGrams ?? -1
  const bWeight = b.weightGrams ?? -1

  if (aWeight !== bWeight) return bWeight - aWeight

  const grindOrder = getVariantGrindSortOrder(a) - getVariantGrindSortOrder(b)
  if (grindOrder !== 0) return grindOrder

  return a.name.localeCompare(b.name, "ru")
}

async function upsertProduct(params: {
  payload: Payload
  product: MoyskladProduct
  variants: MoyskladVariant[]
  assortmentById: Map<string, MoyskladAssortment>
  category: PayloadCategoryDoc
  productType: PayloadProductTypeDoc
  stats: ImportStats
}) {
  const productId = params.product.id || extractMoyskladId(params.product)
  if (!productId) {
    params.stats.skippedProducts.push(params.product.name || "Товар без id")
    return null
  }

  const assortmentProduct = params.assortmentById.get(productId) || params.product
  const variantItems = params.variants.length > 0
    ? params.variants.map((variant) => params.assortmentById.get(variant.id || "") || variant)
    : [assortmentProduct]

  const detailsSchema = schemaForName(`${params.productType.name || ""} ${params.product.name || ""}`)
  const useParentStockForVariants =
    detailsSchema === "coffee" &&
    params.variants.length > 0 &&
    params.variants.some((variant) => inferWeightGrams(variant.name || "") !== null)
  // 12.11.2026: остатки на видимость/доступность не влияют — всегда доступно.
  const parentHasAvailableStock = true

  const sourceVariantRows = variantItems.map((item) => ({
    source: item,
    payload: variantPayloadFromMoysklad(item, params.product.name || "Товар", {
      isAvailableOverride: useParentStockForVariants ? parentHasAvailableStock : undefined,
    }),
  }))
  const variantRows = useParentStockForVariants
    ? await Promise.all(sourceVariantRows.map(applyExistingBundlePrice))
    : sourceVariantRows
  const variants = variantRows
    .map((row) => row.payload)
    .sort(compareImportedVariants)

  if (useParentStockForVariants) {
    for (const row of variantRows) {
      const variantId = getEntityId(row.source)
      const weightGrams = row.payload.weightGrams
      if (!variantId || !weightGrams) continue

      try {
        await ensureMoyskladBundleForVariant({
          productMoyskladId: productId,
          variantMoyskladId: variantId,
          variantName: row.source.name || `${params.product.name || "Товар"} (${row.payload.name})`,
          variantCode: row.source.code || row.payload.sku,
          variantArticle: row.source.article || row.payload.sku,
          salePrices: row.source.salePrices,
          productFolder: params.product.productFolder,
          weightGrams,
          priceRub: row.payload.price,
        })
      } catch (error) {
        params.stats.skippedProducts.push(
          `${row.source.name || row.payload.name}: не удалось создать комплект (${error instanceof Error ? error.message : "ошибка"})`
        )
      }
    }
  }
  const slug = slugify(params.product.name || "product", `product-${shortId(productId)}`)
  // isVisible здесь намеренно отсутствует: видимостью товара управляет только
  // галочка «видим в каталоге» в админке сайта, независимо от остатков.
  // При создании нового товара ниже выставляется isVisible = !archived.
  const accountingData = {
    name: params.product.name || "Товар",
    slug,
    moyskladId: productId,
    productTypeRef: params.productType.id,
    category: params.category.id,
    variants,
  }

  const existing = await findByMoyskladId<PayloadProductDoc>(params.payload, "products", productId)
  if (existing) {
    const updated = await params.payload.update({
      collection: "products",
      id: existing.id,
      data: {
        ...accountingData,
        variants: preserveVariantPackaging(variants, existing.variants || []),
      },
    })
    params.stats.productsUpdated += 1
    params.stats.variantsImported += variants.length
    params.stats.variantsHidden += variants.filter((variant) => !variant.isAvailable).length
    return updated
  }

  const bySlug = await findBySlug<PayloadProductDoc>(params.payload, "products", slug)
  if (bySlug) {
    const updated = await params.payload.update({
      collection: "products",
      id: bySlug.id,
      data: {
        ...accountingData,
        moyskladId: productId,
        variants: preserveVariantPackaging(variants, bySlug.variants || []),
      },
    })
    params.stats.productsUpdated += 1
    params.stats.variantsImported += variants.length
    params.stats.variantsHidden += variants.filter((variant) => !variant.isAvailable).length
    return updated
  }

  const created = await params.payload.create({
    collection: "products",
    data: {
      ...accountingData,
      // Новый товар по умолчанию виден (если не архивен в МойСклад);
      // дальше видимостью управляет только админка сайта.
      isVisible: !params.product.archived,
      detailsSchema,
      sortOrder: 0,
    },
  })
  params.stats.productsCreated += 1
  params.stats.variantsImported += variants.length
  params.stats.variantsHidden += variants.filter((variant) => !variant.isAvailable).length
  return created
}

export async function importMoyskladCatalog(payload: Payload) {
  const config = getMoyskladConfig()
  if (!config.enabled) {
    return { ok: false as const, error: "MOYSKLAD_ENABLED не включен" }
  }

  const stats: ImportStats = {
    productTypesCreated: 0,
    productTypesUpdated: 0,
    productTypesDeleted: 0,
    categoriesCreated: 0,
    categoriesUpdated: 0,
    categoriesDeleted: 0,
    productsCreated: 0,
    productsUpdated: 0,
    productsHidden: 0,
    productsDeleted: 0,
    variantsImported: 0,
    variantsHidden: 0,
    clientCategoryDiscountsDeleted: 0,
    skippedProducts: [],
  }

  const [folders, products, variants, assortment] = await Promise.all([
    fetchAll(fetchMoyskladProductFolders),
    fetchAll(fetchMoyskladProducts),
    fetchAll(fetchMoyskladVariants),
    fetchAll(fetchMoyskladAssortment),
  ])

  const allActiveFolders = folders.filter((folder) => !folder.archived && folder.name)
  const allFolderByFullName = new Map(allActiveFolders.map((folder) => [getFolderFullName(folder), folder]))
  const activeFolders = allActiveFolders.filter((folder) => !isExcludedFolder(folder, allFolderByFullName))
  const sortedFolders = [...activeFolders].sort((a, b) => {
    return getFolderDepth(a) - getFolderDepth(b) || getFolderFullName(a).localeCompare(getFolderFullName(b), "ru")
  })
  const folderById = new Map(
    allActiveFolders
      .map((folder) => [getFolderId(folder), folder] as const)
      .filter((entry): entry is readonly [string, MoyskladProductFolder] => Boolean(entry[0]))
  )

  await hideExcludedCatalogEntries({
    payload,
    folders: allActiveFolders,
    products,
    folderById,
    folderByFullName: allFolderByFullName,
    stats,
  })

  const folderByFullName = new Map(activeFolders.map((folder) => [getFolderFullName(folder), folder]))
  const rootFolders = activeFolders.filter((folder) => !folder.pathName)
  const allRootFolders = allActiveFolders.filter((folder) => !folder.pathName)
  const rootFolderIds = new Set(allRootFolders.map(getFolderId).filter(Boolean) as string[])
  const activeCategoryFolderIds = new Set(
    allActiveFolders
      .map((folder) => getFolderId(folder))
      .filter((folderId): folderId is string => {
        if (!folderId) return false
        return !rootFolderIds.has(folderId)
      })
  )
  const rootTypeByName = new Map<string, PayloadProductTypeDoc>()
  const categoryByFolderId = new Map<string, PayloadCategoryDoc>()

  for (const root of rootFolders) {
    const rootName = root.name || "Каталог"
    const type = await upsertProductType(payload, root, rootName, stats)
    rootTypeByName.set(rootName, type)
  }

  for (const folder of sortedFolders) {
    const folderId = getFolderId(folder)
    if (!folderId) continue
    if (!activeCategoryFolderIds.has(folderId)) continue

    const rootName = getFolderRootName(folder)
    let productType = rootTypeByName.get(rootName)
    if (!productType) {
      productType = await upsertProductType(payload, folder, rootName, stats)
      rootTypeByName.set(rootName, productType)
    }

    let parent: PayloadCategoryDoc | null = null
    if (folder.pathName) {
      const parentPath = folder.pathName
      const parentFolder = folderByFullName.get(parentPath)
      const parentId = getFolderId(parentFolder)
      if (parentId && !rootFolderIds.has(parentId)) parent = categoryByFolderId.get(parentId) || null
    }

    const category = await upsertCategory({
      payload,
      folder,
      productType,
      parent,
      stats,
    })
    categoryByFolderId.set(folderId, category)
  }

  const assortmentById = new Map(
    assortment
      .map((item) => [item.id || extractMoyskladId(item), item] as const)
      .filter(([id]) => Boolean(id))
  ) as Map<string, MoyskladAssortment>

  const variantsByProductId = new Map<string, MoyskladVariant[]>()
  for (const variant of variants.filter((item) => !item.archived)) {
    const productId = extractMoyskladId(variant.product)
    if (!productId) continue
    const rows = variantsByProductId.get(productId) || []
    rows.push(variant)
    variantsByProductId.set(productId, rows)
  }

  const validProductIds = new Set<string>()

  for (const product of products.filter((item) => !item.archived)) {
    const productId = getEntityId(product)
    const productFolderId = extractMoyskladId(product.productFolder)
    const folder = productFolderId ? folderById.get(productFolderId) : null

    if (folder && isExcludedFolder(folder, allFolderByFullName)) {
      if (productId) validProductIds.add(productId)
      continue
    }

    let productType: PayloadProductTypeDoc | undefined
    let category: PayloadCategoryDoc | undefined

    if (folder) {
      productType = rootTypeByName.get(getFolderRootName(folder))
      category = productFolderId ? categoryByFolderId.get(productFolderId) : undefined
    }

    if (!productType || !category) {
      stats.skippedProducts.push(`${product.name || product.id}: нет подгруппы МойСклад`)
      continue
    }

    if (productId) validProductIds.add(productId)

    await upsertProduct({
      payload,
      product,
      variants: variantsByProductId.get(product.id || "") || [],
      assortmentById,
      productType,
      category,
      stats,
    })
  }

  await deleteObsoleteProducts(payload, validProductIds, stats)
  await deleteObsoleteCategories(payload, activeCategoryFolderIds, stats)
  await deleteObsoleteProductTypes(payload, rootFolderIds, stats)

  return {
    ok: true as const,
    stats,
  }
}
