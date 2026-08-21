CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`ip_type` text,
	`ip` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_events_node_created` ON `events` (`node_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_events_created_at` ON `events` (`created_at`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`region` text DEFAULT 'unknown' NOT NULL,
	`token_hash` text NOT NULL,
	`provider` text DEFAULT 'cloudflare' NOT NULL,
	`zone_id` text,
	`record_v4` text,
	`record_v6` text,
	`sync_enabled` integer DEFAULT true NOT NULL,
	`ipv4` text,
	`ipv6` text,
	`agent_version` text,
	`nyanpass_status` text DEFAULT '未安装' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_nodes_token_hash` ON `nodes` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_nodes_last_seen_at` ON `nodes` (`last_seen_at`);