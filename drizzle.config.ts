import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

dotenv.config();

if (!process.env["DATABASE_URL"]) {
  throw new Error("DATABASE_URL environment variable is required for drizzle-kit operations.");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"],
  },
  verbose: true,
  strict: true,
});
