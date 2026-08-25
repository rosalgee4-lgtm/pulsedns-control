ALTER TABLE `nodes` ADD `last_task_poll_at` integer;--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD `optimize` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD `credential_ciphertext` text;--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD `config_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD `active_task_id` text;--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD `sync_error` text;--> statement-breakpoint
UPDATE `nyanpass_instances` SET `status` = 'legacy' WHERE `status` = '等待安装';--> statement-breakpoint
CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`kind` text DEFAULT 'nyanpass_apply_v1' NOT NULL,
	`revision` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`lease_token_hash` text,
	`lease_expires_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`claimed_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `nyanpass_instances`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_tasks_instance_revision` ON `agent_tasks` (`instance_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_node_status_created` ON `agent_tasks` (`node_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_instance_status` ON `agent_tasks` (`instance_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_nyanpass_active_task` ON `nyanpass_instances` (`active_task_id`);
