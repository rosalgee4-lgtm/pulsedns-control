ALTER TABLE `nodes` ADD `provision_last_completed_step` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `bootstrap_download_expires_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `bootstrap_download_consumed_at` integer;--> statement-breakpoint
UPDATE `nodes`
SET `bootstrap_download_expires_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 1800000
WHERE `bootstrap_download_token_hash` IS NOT NULL AND `bootstrap_download_expires_at` IS NULL;
