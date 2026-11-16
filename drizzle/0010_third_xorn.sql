CREATE TABLE `domains` (
	`name` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `domains` (`name`, `created_at`) SELECT DISTINCT `domain_name`, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM `nodes` WHERE `domain_name` IS NOT NULL AND `domain_name` <> '';
