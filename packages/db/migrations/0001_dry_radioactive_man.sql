DROP INDEX "one_active_scheduling_session";--> statement-breakpoint
DROP INDEX "review_card_identity";--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD COLUMN "framework" text DEFAULT 'node' NOT NULL;--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD COLUMN "assessment" jsonb;--> statement-breakpoint
ALTER TABLE "review_cards" ADD COLUMN "framework" text DEFAULT 'node' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "one_active_scheduling_session" ON "practice_sessions" USING btree ("user_id","exercise_id","framework","language") WHERE "practice_sessions"."status" = 'active' and "practice_sessions"."kind" <> 'practice';--> statement-breakpoint
CREATE UNIQUE INDEX "review_card_identity" ON "review_cards" USING btree ("user_id","exercise_id","framework","language");--> statement-breakpoint
ALTER TABLE "practice_sessions" ADD CONSTRAINT "session_framework" CHECK ("practice_sessions"."framework" in ('node','vanilla','react','vue','svelte'));--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_framework" CHECK ("review_cards"."framework" in ('node','vanilla','react','vue','svelte'));