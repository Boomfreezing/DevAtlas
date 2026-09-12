import { createOrder } from "./orders";

export function registerRoutes(app, db) {
  app.post("/orders", async (request, response) => {
    try {
      const order = await createOrder(db, request.body.items);
      response.status(201).json(order);
    } catch (error) {
      response.status(400).json({ error: "empty order" });
    }
  });
}
