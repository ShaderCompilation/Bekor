CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistance_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"case_index" integer NOT NULL,
	"is_public" boolean NOT NULL,
	"passed" boolean NOT NULL,
	"verdict" text NOT NULL,
	"actual" jsonb,
	"diagnostic" text
);
--> statement-breakpoint
CREATE TABLE "cli_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "cli_tokens_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "execution_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"submission_id" uuid NOT NULL,
	"case_index" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" text NOT NULL,
	"provider_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb,
	CONSTRAINT "execution_attempt_bounds" CHECK ("execution_attempts"."case_index" >= 0 and "execution_attempts"."attempt_number" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "exercise_versions" (
	"exercise_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exercise_versions_exercise_id_version_pk" PRIMARY KEY("exercise_id","version"),
	CONSTRAINT "exercise_version_status" CHECK ("exercise_versions"."status" in ('published','retired'))
);
--> statement-breakpoint
CREATE TABLE "practice_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"exercise_id" text NOT NULL,
	"exercise_version" text NOT NULL,
	"language" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"rating" text,
	"completion" jsonb,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "session_language" CHECK ("practice_sessions"."language" in ('javascript','typescript')),
	CONSTRAINT "session_kind" CHECK ("practice_sessions"."kind" in ('learning','review','practice')),
	CONSTRAINT "session_status" CHECK ("practice_sessions"."status" in ('active','completed'))
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"daily_review_limit" integer DEFAULT 20 NOT NULL,
	CONSTRAINT "preferences_daily_limit" CHECK ("preferences"."daily_review_limit" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "problem_progress" (
	"user_id" text NOT NULL,
	"exercise_id" text NOT NULL,
	"language" text NOT NULL,
	"first_accepted_at" timestamp with time zone NOT NULL,
	"last_accepted_at" timestamp with time zone NOT NULL,
	"last_submission_id" uuid NOT NULL,
	CONSTRAINT "problem_progress_user_id_exercise_id_language_pk" PRIMARY KEY("user_id","exercise_id","language")
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "problems_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "review_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"exercise_id" text NOT NULL,
	"language" text NOT NULL,
	"state" jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"scheduler_version" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"exercise_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb NOT NULL,
	"assistance" jsonb NOT NULL,
	"scheduler_version" text NOT NULL,
	"configuration" jsonb NOT NULL,
	CONSTRAINT "review_events_session_id_unique" UNIQUE("session_id")
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"exercise_id" text NOT NULL,
	"exercise_version" text NOT NULL,
	"language" text NOT NULL,
	"mode" text NOT NULL,
	"files" jsonb NOT NULL,
	"practice_session_id" uuid,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"verdict" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"total_count" integer NOT NULL,
	"diagnostic" text,
	"public_results" jsonb,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"worker_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "submission_language" CHECK ("submissions"."language" in ('javascript','typescript')),
	CONSTRAINT "submission_mode" CHECK ("submissions"."mode" in ('run','submit')),
	CONSTRAINT "submission_status" CHECK ("submissions"."status" in ('queued','running','completed','infrastructure_error')),
	CONSTRAINT "submission_verdict" CHECK ("submissions"."verdict" is null or "submissions"."verdict" in ('accepted','wrong_answer','syntax_error','compilation_error','runtime_error','time_limit_exceeded','memory_limit_exceeded','output_limit_exceeded')),
	CONSTRAINT "submission_counts" CHECK ("submissions"."passed_count" >= 0 and "submissions"."total_count" between 1 and 100 and "submissions"."passed_count" <= "submissions"."total_count")
);
--> statement-breakpoint
CREATE TABLE "auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistance_events" ADD CONSTRAINT "assistance_events_session_id_practice_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."practice_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_results" ADD CONSTRAINT "case_results_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_tokens" ADD CONSTRAINT "cli_tokens_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_versions" ADD CONSTRAINT "exercise_versions_exercise_id_problems_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "practice_sessions_exercise_id_problems_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_progress" ADD CONSTRAINT "problem_progress_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_progress" ADD CONSTRAINT "problem_progress_exercise_id_problems_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_progress" ADD CONSTRAINT "problem_progress_last_submission_id_submissions_id_fk" FOREIGN KEY ("last_submission_id") REFERENCES "public"."submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_exercise_id_problems_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_session_id_practice_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."practice_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_events" ADD CONSTRAINT "review_events_card_id_review_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."review_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_exercise_id_problems_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."problems"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_practice_session_id_practice_sessions_id_fk" FOREIGN KEY ("practice_session_id") REFERENCES "public"."practice_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_account_provider_idx" ON "auth_account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_result_once" ON "case_results" USING btree ("submission_id","case_index");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_case_attempt" ON "execution_attempts" USING btree ("submission_id","case_index","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_scheduling_session" ON "practice_sessions" USING btree ("user_id","exercise_id","language") WHERE "practice_sessions"."status" = 'active' and "practice_sessions"."kind" <> 'practice';--> statement-breakpoint
CREATE UNIQUE INDEX "review_card_identity" ON "review_cards" USING btree ("user_id","exercise_id","language");--> statement-breakpoint
CREATE INDEX "review_due" ON "review_cards" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submission_idempotency" ON "submissions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "submission_history" ON "submissions" USING btree ("user_id","created_at","id");