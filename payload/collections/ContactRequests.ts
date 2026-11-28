import type { CollectionConfig } from "payload";
import {
  operationsCreateAccess,
  operationsDeleteAccess,
  operationsReadAccess,
  operationsUpdateAccess,
} from "../access/adminRoles";

export const ContactRequests: CollectionConfig = {
  slug: "contact-requests",
  labels: {
    singular: "Обращение с сайта",
    plural: "Обращения с сайта",
  },
  admin: {
    useAsTitle: "name",
    group: "Маркетинг",
    description: "Сообщения посетителей через форму «Написать нам»",
    defaultColumns: ["name", "email", "phone", "createdAt"],
  },
  access: {
    create: operationsCreateAccess,
    read: operationsReadAccess,
    update: operationsUpdateAccess,
    delete: operationsDeleteAccess,
  },
  fields: [
    {
      name: "name",
      type: "text",
      label: "Имя",
      required: true,
    },
    {
      type: "row",
      fields: [
        {
          name: "email",
          type: "email",
          label: "Email",
          admin: { width: "50%" },
        },
        {
          name: "phone",
          type: "text",
          label: "Телефон",
          admin: { width: "50%" },
        },
      ],
    },
    {
      name: "message",
      type: "textarea",
      label: "Сообщение",
      required: true,
    },
    {
      name: "consent",
      type: "checkbox",
      label: "Согласие на обработку персональных данных",
      required: true,
      admin: { readOnly: true, position: "sidebar" },
    },
    {
      name: "source",
      type: "text",
      label: "Источник",
      defaultValue: "landing-contact",
      admin: { readOnly: true, position: "sidebar" },
    },
  ],
  timestamps: true,
};
