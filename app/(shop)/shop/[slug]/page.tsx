import { cache } from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { getCachedShopProducts, getFavoriteProductIds, getProductBySlug, getProductTypes } from "@/lib/actions/products"
import { getCoffeeBrewingGuides } from "@/lib/actions/coffee-brewing-guides"
import { ShopProduct } from "@/components/shop/shop-product"
import type { Product } from "@/types"

export const dynamic = "force-dynamic"

const SHOP_ORIGIN = "https://shop.10coffee.ru"

// generateMetadata and the page both need the product — cache() dedupes the
// Payload query within one request.
const getProduct = cache(getProductBySlug)

interface ShopProductPageProps {
  params: Promise<{ slug: string }>
}

function stripHtml(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

function absoluteImage(src: string) {
  return src.startsWith("http") ? src : `${SHOP_ORIGIN}${src}`
}

function productDescription(product: Product) {
  const plain = product.description ? stripHtml(product.description) : ""
  if (plain.length > 0) return plain.slice(0, 160)
  return `${product.name} — купить в интернет-магазине 10coffee. Свежая обжарка в Сочи, доставка по всей России.`
}

export async function generateMetadata({ params }: ShopProductPageProps): Promise<Metadata> {
  const { slug } = await params
  const product = await getProduct(slug)
  if (!product) return {}

  const description = productDescription(product)
  const images = (product.images || []).map(absoluteImage)

  return {
    title: `${product.name} — купить в интернет-магазине`,
    description,
    alternates: { canonical: `/shop/${product.slug}` },
    openGraph: {
      title: `${product.name} — 10coffee`,
      description,
      url: `/shop/${product.slug}`,
      type: "website",
      images: images.length > 0 ? images : undefined,
    },
  }
}

function buildProductJsonLd(product: Product) {
  const availableVariants = (product.variants || []).filter((variant) => variant.is_available && variant.price > 0)
  const prices = availableVariants.map((variant) => variant.price)
  const images = (product.images || []).map(absoluteImage)

  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: productDescription(product),
    url: `${SHOP_ORIGIN}/shop/${product.slug}`,
    brand: { "@type": "Brand", name: "10coffee" },
    ...(images.length > 0 ? { image: images } : {}),
    ...(prices.length > 0
      ? {
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "RUB",
            lowPrice: Math.min(...prices),
            highPrice: Math.max(...prices),
            offerCount: prices.length,
            availability: "https://schema.org/InStock",
            url: `${SHOP_ORIGIN}/shop/${product.slug}`,
          },
        }
      : {}),
    ...(product.rating && product.reviews_count
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: product.rating,
            reviewCount: product.reviews_count,
          },
        }
      : {}),
  }

  // JSON-LD is inert data; escaping "<" keeps the script tag safe.
  return JSON.stringify(jsonLd).replace(/</g, "\\u003c")
}

export default async function ShopProductPage({ params }: ShopProductPageProps) {
  const { slug } = await params
  const [product, products, productTypes, favoriteIds, coffeeBrewingGuides] = await Promise.all([
    getProduct(slug),
    getCachedShopProducts(),
    getProductTypes(),
    getFavoriteProductIds("individual"),
    getCoffeeBrewingGuides(),
  ])
  if (!product) notFound()
  const selectedGuideIds = new Set(product.coffee_brewing_guide_ids || [])
  const selectedGuides = coffeeBrewingGuides.filter((guide) => selectedGuideIds.has(guide.id))

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: buildProductJsonLd(product) }} />
      <ShopProduct product={product} products={products} productTypes={productTypes} isFavorite={favoriteIds.includes(product.id)} coffeeBrewingGuides={selectedGuides} />
    </>
  )
}
