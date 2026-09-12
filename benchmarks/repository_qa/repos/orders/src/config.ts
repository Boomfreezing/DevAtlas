export const config = {
  port: Number(process.env.PORT ?? "8200"),
  maxItems: Number(process.env.MAX_ITEMS ?? "50"),
};
