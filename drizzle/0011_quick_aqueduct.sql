CREATE TABLE `aliyun_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`access_key_id` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_aliyun_accounts_name` ON `aliyun_accounts` (`name`);--> statement-breakpoint
ALTER TABLE `domains` ADD `account_id` text;--> statement-breakpoint
CREATE INDEX `idx_domains_account` ON `domains` (`account_id`);