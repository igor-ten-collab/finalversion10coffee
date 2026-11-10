import type { CollectionConfig } from "payload"
import { contentManagerOnly, superAdminOnly } from "../access/adminRoles"
import { importMoyskladCatalog } from "@/lib/moysklad/import-catalog"
import { notifyProductRestock } from "../hooks/productRestock"
import { PRODUCT_DETAILS_SCHEMA_OPTIONS, getRelationshipId } from "@/lib/product-types"
import { syncProductTypeConfig } from "../hooks/syncProductTypeConfig"
import { ensureSlug } from "../hooks/ensureSlug"

export const Products: CollectionConfig = {
  slug: "products",
  admin: {
    useAsTitle: "name",
    group: "Каталог",
    description: "Товары каталога",
    defaultColumns: ["name", "productTypeRef", "category", "isPopular", "isVisible", "stickers"],
    components: {
      beforeList: ["/payload/components/MoyskladCatalogSyncButton"],
    },
  },
  labels: {
    singular: "Товар",
    plural: "Товары",
  },
  endpoints: [
    {
      path: "/moysklad/import",
      method: "post",
      handler: async (req) => {
        if (!req.user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 })
        }

        try {
          const result = await importMoyskladCatalog(req.payload)
          return Response.json(result)
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : "Не удалось синхронизировать каталог" },
            { status: 500 }
          )
        }
      },
    },
  ],
  fields: [
    // === ОСНОВНОЕ ===
    {
      name: "name",
      type: "text",
      label: "Название",
      required: true,
    },
    {
      name: "slug",
      type: "text",
      label: "Slug (URL)",
      required: true,
      unique: true,
      admin: {
        components: {
          Field: "/payload/components/SlugField",
        },
      },
    },
    {
      name: "productTypeRef",
      type: "relationship",
      label: "Тип товара",
      relationTo: "product-types",
      required: true,
      admin: {
        description: "Основной управляемый тип для вкладок каталога.",
        components: {
          Field: "/payload/components/ProductTypeRelationshipField",
        },
      },
    },
    {
      name: "detailsSchema",
      type: "select",
      label: "Схема характеристик",
      defaultValue: "generic",
      options: [...PRODUCT_DETAILS_SCHEMA_OPTIONS],
      admin: {
        hidden: true,
      },
    },
    {
      name: "category",
      type: "relationship",
      label: "Категория",
      relationTo: "categories",
      required: true,
      filterOptions: ({ siblingData }) => {
        const typeId = getRelationshipId((siblingData as { productTypeRef?: unknown })?.productTypeRef)
        if (!typeId) return true

        return {
          productTypeRef: { equals: typeId },
        }
      },
      admin: {
        description: "Категории автоматически фильтруются по выбранному типу товара.",
      },
    },
    {
      name: "description",
      type: "richText",
      label: "Описание",
    },
    {
      name: "images",
      type: "array",
      label: "Фото галерея",
      fields: [
        {
          name: "image",
          type: "upload",
          label: "Изображение",
          relationTo: "media",
          required: true,
        },
      ],
    },
    {
      name: "videoUrls",
      type: "array",
      label: "Видео",
      fields: [
        {
          name: "url",
          type: "text",
          label: "URL видео",
        },
      ],
    },

    // === ТЕГИ ===
    {
      name: "stickers",
      type: "relationship",
      label: "Теги",
      relationTo: "tags",
      hasMany: true,
      admin: {
        position: "sidebar",
        description: "Выберите теги из списка или создайте новые в разделе «Теги»",
      },
    },
    {
      name: "sortOrder",
      type: "number",
      label: "Порядок сортировки",
      defaultValue: 0,
      admin: {
        position: "sidebar",
      },
    },
    {
      name: "isVisible",
      type: "checkbox",
      label: "Видим в каталоге",
      defaultValue: true,
      admin: {
        position: "sidebar",
      },
    },
    {
      name: "isPopular",
      type: "checkbox",
      label: "Популярный товар",
      defaultValue: false,
      index: true,
      admin: {
        position: "sidebar",
        description: "Показывать товар в блоке «Популярные товары» на главной странице магазина.",
      },
    },
    {
      name: "manualRating",
      type: "number",
      label: "Рейтинг (ручной)",
      min: 0,
            max: 7,
      admin: {
        position: "sidebar",
        description: "Оставьте пустым, чтобы рейтинг считался автоматически из оценок в разделе «Отзывы». Укажите значение, чтобы зафиксировать рейтинг вручную (например, 4.9).",
      },
    },
    {
      name: "manualRatingCount",
      type: "number",
      label: "Кол-во оценок (ручное)",
      min: 0,
      admin: {
        position: "sidebar",
        description: "Сколько оценок показывать рядом с рейтингом. Если пусто — используется реальное количество отзывов.",
      },
    },
    {
      name: "moyskladId",
      type: "text",
      label: "ID товара в МойСклад",
      admin: {
        position: "sidebar",
        description: "ID основного товара. Для заказов чаще используется ID модификации внутри варианта.",
      },
    },

    // === ВАРИАНТЫ ФАСОВКИ ===
    {
      name: "variants",
      type: "array",
      label: "Варианты фасовки",
      required: true,
      minRows: 1,
      fields: [
        {
          name: "name",
          type: "text",
          label: "Название (напр. 250 г, 1 кг)",
          required: true,
        },
        {
          name: "sku",
          type: "text",
          label: "Артикул (SKU)",
        },
        {
          name: "skuGround",
          type: "text",
          label: "Артикул молотого (SKU)",
          admin: {
            description: "Штрихкод КофеСклад для молотого варианта этой фасовки. В sku — штрихкод зернового.",
          },
        },
        {
          name: "moyskladId",
          type: "text",
          label: "ID позиции в МойСклад",
          admin: {
            description: "ID модификации, товара или услуги, который уйдет в заказ МойСклад.",
          },
        },
        {
          name: "moyskladType",
          type: "select",
          label: "Тип позиции МойСклад",
          defaultValue: "variant",
          options: [
            { label: "Модификация", value: "variant" },
            { label: "Товар", value: "product" },
            { label: "Услуга", value: "service" },
          ],
        },
        {
          name: "price",
          type: "number",
          label: "Цена (руб)",
          required: true,
          min: 0,
        },
        {
          name: "weightGrams",
          type: "number",
          label: "Вес (грамм)",
        },
        {
          type: "row",
          admin: {
            className: "product-shipping-grid",
          },
          fields: [
            {
              name: "shippingLengthCm",
              type: "number",
              label: "Длина упаковки для доставки, см",
              min: 1,
              admin: {
                width: "25%",
                description: "Служебное поле для расчёта Яндекс Доставки. В витрине не показывается.",
              },
            },
            {
              name: "shippingWidthCm",
              type: "number",
              label: "Ширина упаковки, см",
              min: 1,
              admin: { width: "25%" },
            },
            {
              name: "shippingHeightCm",
              type: "number",
              label: "Высота упаковки, см",
              min: 1,
              admin: { width: "25%" },
            },
            {
              name: "shippingWeightGrams",
              type: "number",
              label: "Вес брутто, г",
              min: 1,
              admin: {
                width: "25%",
                description: "Товар вместе с транспортной упаковкой.",
              },
            },
          ],
        },
        {
          name: "isAvailable",
          type: "checkbox",
          label: "В наличии",
          defaultValue: true,
        },
        {
          name: "grindOptions",
          type: "select",
          label: "Опции помола",
          hasMany: true,
          options: [
            { label: "В зёрнах", value: "beans" },
            { label: "Молотый", value: "ground" },
          ],
        },
      ],
    },

    // === ХАРАКТЕРИСТИКИ КОФЕ ===
    {
      name: "coffeeDetails",
      type: "group",
      label: "Характеристики кофе",
      admin: {
        condition: (data) => data?.detailsSchema === "coffee",
      },
      fields: [
        {
          name: "roaster",
          type: "text",
          label: "Обжарщик",
        },
        {
          name: "roastLevel",
          type: "text",
          label: "Уровень обжарки",
        },
        {
          name: "region",
          type: "text",
          label: "Регион произрастания",
        },
        {
          name: "country",
          type: "text",
          label: "Страна происхождения",
        },
        {
          name: "processingMethod",
          type: "text",
          label: "Способ обработки",
        },
        {
          name: "tasteDescription",
          type: "textarea",
          label: "Описание вкуса",
          admin: {
            description: "Дескрипторы вкуса из актуального прайс-листа или карточки производителя.",
          },
        },
        {
          name: "acidity",
          type: "number",
          label: "Интенсивность кислотности",
          min: 1,
          max: 7,
          admin: {
            description: "Количество заполненных точек по семибалльной шкале.",
          },
        },
        {
          name: "bitterness",
          type: "number",
          label: "Горечь",
          min: 1,
          max: 7,
          admin: {
            description: "Интенсивность горечи по семибалльной шкале.",
          },
        },
        {
          name: "sweetness",
          type: "number",
          label: "Сладость",
          min: 1,
          max: 7,
          admin: {
            description: "Интенсивность сладости по семибалльной шкале.",
          },
        },
        {
          name: "body",
          type: "number",
          label: "Плотность",
          min: 1,
          max: 7,
          admin: {
            description: "Плотность напитка по семибалльной шкале.",
          },
        },
        {
          name: "brewGroup",
          type: "select",
          label: "Группа в каталоге кофе",
          index: true,
          options: [
            { label: "Эспрессо", value: "espresso" },
            { label: "Фильтр", value: "filter" },
            { label: "Дрип-кофе", value: "drip" },
          ],
        },
        {
          name: "growingHeight",
          type: "text",
          label: "Высота произрастания",
          admin: {
            description: "Например: 1200-1500 м",
          },
        },
        {
          name: "qGraderRating",
          type: "number",
          label: "Q-грейд рейтинг",
          min: 0,
          max: 100,
        },
        {
          name: "brewingMethods",
          type: "relationship",
          label: "Способы приготовления",
          relationTo: "coffee-brewing-guides",
          hasMany: true,
          admin: {
            description: "Выберите один или несколько способов, созданных в разделе «Способы приготовления кофе».",
          },
        },
      ],
    },

    // === ХАРАКТЕРИСТИКИ ЧАЯ ===
    {
      name: "teaDetails",
      type: "group",
      label: "Характеристики чая",
      admin: {
        condition: (data) => data?.detailsSchema === "tea",
      },
      fields: [
        {
          name: "brewingInstructions",
          type: "array",
          label: "Как заваривать",
          fields: [
            {
              name: "title",
              type: "text",
              label: "Заголовок",
              required: true,
            },
            {
              name: "text",
              type: "textarea",
              label: "Описание",
              required: true,
            },
            {
              name: "image",
              type: "upload",
              label: "Изображение",
              relationTo: "media",
            },
          ],
        },
      ],
    },

    // === ПРИКРЕПЛЁННЫЕ ФАЙЛЫ ===
    {
      name: "attachedFiles",
      type: "array",
      label: "Прикреплённые файлы",
      fields: [
        {
          name: "file",
          type: "upload",
          label: "Файл",
          relationTo: "media",
          required: true,
        },
        {
          name: "label",
          type: "text",
          label: "Подпись",
        },
      ],
    },
  ],
  hooks: {
    beforeValidate: [ensureSlug({ collection: "products", sourceField: "name" })],
    beforeChange: [syncProductTypeConfig],
    afterChange: [notifyProductRestock],
  },
  access: {
    read: () => true,
    create: contentManagerOnly,
    update: contentManagerOnly,
    delete: superAdminOnly,
  },
}
