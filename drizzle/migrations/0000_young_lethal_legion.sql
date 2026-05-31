DO $$ BEGIN
 CREATE TYPE "public"."esg_category" AS ENUM('E', 'S', 'G');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."primer_data_type" AS ENUM('QUANTITATIVE', 'QUALITATIVE', 'HYBRID');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"output_snapshot" jsonb NOT NULL,
	"execution_duration_ms" integer NOT NULL,
	"llm_model_used" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ticker" text NOT NULL,
	"industry_group" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "primer_data" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"primer_id" text NOT NULL,
	"reporting_year" integer NOT NULL,
	"raw_value" jsonb NOT NULL,
	"normalized_value" numeric(10, 8),
	"confidence_score" numeric(5, 4),
	"agent_trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "primers" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" "esg_category" NOT NULL,
	"data_type" "primer_data_type" NOT NULL,
	"validation_rules" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scores" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"primer_id" text NOT NULL,
	"reporting_year" integer NOT NULL,
	"score_value" numeric(5, 2) NOT NULL,
	"percentile_rank" numeric(5, 2),
	"methodology_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_company_primer_year_unique" UNIQUE("company_id","primer_id","reporting_year")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "primer_data" ADD CONSTRAINT "primer_data_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "primer_data" ADD CONSTRAINT "primer_data_primer_id_primers_id_fk" FOREIGN KEY ("primer_id") REFERENCES "public"."primers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "primer_data" ADD CONSTRAINT "primer_data_agent_trace_id_agent_traces_id_fk" FOREIGN KEY ("agent_trace_id") REFERENCES "public"."agent_traces"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scores" ADD CONSTRAINT "scores_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scores" ADD CONSTRAINT "scores_primer_id_primers_id_fk" FOREIGN KEY ("primer_id") REFERENCES "public"."primers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_traces_agent_name_idx" ON "agent_traces" USING btree ("agent_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_traces_created_at_idx" ON "agent_traces" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_ticker_unique_idx" ON "companies" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "primer_data_company_primer_year_idx" ON "primer_data" USING btree ("company_id","primer_id","reporting_year");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "primer_data_company_year_idx" ON "primer_data" USING btree ("company_id","reporting_year");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "primers_code_unique_idx" ON "primers" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "primers_category_idx" ON "primers" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scores_company_primer_year_idx" ON "scores" USING btree ("company_id","primer_id","reporting_year");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scores_company_year_idx" ON "scores" USING btree ("company_id","reporting_year");