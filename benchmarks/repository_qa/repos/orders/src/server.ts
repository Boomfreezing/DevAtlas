import { config } from "./config";
import { registerRoutes } from "./routes";

export function startServer(app, db) {
  registerRoutes(app, db);
  app.listen(config.port);
}
