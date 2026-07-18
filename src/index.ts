import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

app.listen(config.port, () => {
  console.log(`usage-billing-service listening on port ${config.port}`);
});
