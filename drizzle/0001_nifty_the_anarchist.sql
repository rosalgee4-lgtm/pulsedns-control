CREATE TABLE `nyanpass_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`name` text NOT NULL,
	`panel_url` text NOT NULL,
	`ws_port` integer,
	`status` text DEFAULT '等待安装' NOT NULL,
	`last_reported_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_nyanpass_node_name` ON `nyanpass_instances` (`node_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_nyanpass_node_status` ON `nyanpass_instances` (`node_id`,`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`region` text DEFAULT 'unknown' NOT NULL,
	`token_hash` text NOT NULL,
	`provider` text DEFAULT 'alidns' NOT NULL,
	`domain_name` text,
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
INSERT INTO `__new_nodes`("id", "name", "region", "token_hash", "provider", "domain_name", "record_v4", "record_v6", "sync_enabled", "ipv4", "ipv6", "agent_version", "nyanpass_status", "last_seen_at", "created_at", "updated_at") SELECT "id", "name", "region", "token_hash", 'alidns', NULL, "record_v4", "record_v6", "sync_enabled", "ipv4", "ipv6", "agent_version", "nyanpass_status", "last_seen_at", "created_at", "updated_at" FROM `nodes`;--> statement-breakpoint
DROP TABLE `nodes`;--> statement-breakpoint
ALTER TABLE `__new_nodes` RENAME TO `nodes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_nodes_token_hash` ON `nodes` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_nodes_last_seen_at` ON `nodes` (`last_seen_at`);
