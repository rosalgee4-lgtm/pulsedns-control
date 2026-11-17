CREATE TABLE `agent_tasks` (
	`id` varchar(36) NOT NULL,
	`node_id` varchar(36) NOT NULL,
	`instance_id` varchar(36) NOT NULL,
	`kind` varchar(32) NOT NULL DEFAULT 'nyanpass_apply_v1',
	`revision` int NOT NULL,
	`status` varchar(12) NOT NULL DEFAULT 'queued',
	`lease_token_hash` varchar(64),
	`lease_expires_at` datetime(3),
	`attempts` int NOT NULL DEFAULT 0,
	`error_code` varchar(40),
	`error_message` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`claimed_at` datetime(3),
	`finished_at` datetime(3),
	`running_node_id` varchar(36) GENERATED ALWAYS AS ((case when `status` = 'running' then `node_id` end)) STORED,
	CONSTRAINT `agent_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_agent_tasks_instance_revision` UNIQUE(`instance_id`,`revision`),
	CONSTRAINT `idx_agent_tasks_one_running_per_node` UNIQUE(`running_node_id`)
);
--> statement-breakpoint
CREATE TABLE `aliyun_accounts` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`name` varchar(40) NOT NULL,
	`key_ciphertext` text NOT NULL,
	`access_key_id_hint` varchar(32) NOT NULL,
	`access_key_secret_hint` varchar(32) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `aliyun_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_aliyun_accounts_owner_name` UNIQUE(`owner_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`name` varchar(253) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`account_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `domains_name` PRIMARY KEY(`name`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`node_id` varchar(36) NOT NULL,
	`level` varchar(10) NOT NULL DEFAULT 'info',
	`kind` varchar(40) NOT NULL,
	`message` text NOT NULL,
	`ip_type` varchar(4),
	`ip` varchar(45),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`scope` varchar(200) NOT NULL,
	`failures` int NOT NULL,
	`window_started_at` datetime(3) NOT NULL,
	`locked_until` datetime(3),
	CONSTRAINT `login_attempts_scope` PRIMARY KEY(`scope`)
);
--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`region` varchar(32) NOT NULL DEFAULT 'unknown',
	`token_hash` varchar(64) NOT NULL,
	`provider` varchar(16) NOT NULL DEFAULT 'alidns',
	`domain_name` varchar(253),
	`record_v4` varchar(253),
	`record_v6` varchar(253),
	`sync_enabled` boolean NOT NULL DEFAULT true,
	`ipv4` varchar(15),
	`ipv6` varchar(45),
	`agent_version` varchar(30),
	`nyanpass_status` varchar(20) NOT NULL DEFAULT 'awaiting',
	`provision_generation` int NOT NULL DEFAULT 0,
	`provision_attempt_id` varchar(36),
	`provision_lease_expires_at` datetime(3),
	`provision_last_completed_step` varchar(16),
	`bootstrap_payload_ciphertext` mediumtext,
	`bootstrap_download_token_hash` varchar(64),
	`dns_operation_id` varchar(36),
	`dns_operation_expires_at` datetime(3),
	`last_seen_at` datetime(3),
	`last_task_poll_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`dns_v4_owner` varchar(510) GENERATED ALWAYS AS ((case when `sync_enabled` = 1 and `domain_name` is not null and `record_v4` is not null then concat(`domain_name`, '|', `record_v4`) end)) STORED,
	`dns_v6_owner` varchar(510) GENERATED ALWAYS AS ((case when `sync_enabled` = 1 and `domain_name` is not null and `record_v6` is not null then concat(`domain_name`, '|', `record_v6`) end)) STORED,
	CONSTRAINT `nodes_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_nodes_token_hash` UNIQUE(`token_hash`),
	CONSTRAINT `idx_nodes_dns_v4_owner` UNIQUE(`dns_v4_owner`),
	CONSTRAINT `idx_nodes_dns_v6_owner` UNIQUE(`dns_v6_owner`),
	CONSTRAINT `idx_nodes_bootstrap_download_token_hash` UNIQUE(`bootstrap_download_token_hash`)
);
--> statement-breakpoint
CREATE TABLE `nyanpass_instances` (
	`id` varchar(36) NOT NULL,
	`node_id` varchar(36) NOT NULL,
	`name` varchar(64) NOT NULL,
	`role` varchar(10) NOT NULL DEFAULT 'outbound',
	`panel_url` varchar(255) NOT NULL,
	`ws_port` int,
	`status` varchar(12) NOT NULL DEFAULT 'legacy',
	`optimize` boolean NOT NULL DEFAULT false,
	`credential_ciphertext` text,
	`config_revision` int NOT NULL DEFAULT 0,
	`bootstrap_generation` int,
	`active_task_id` varchar(36),
	`sync_error` text,
	`last_reported_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `nyanpass_instances_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_nyanpass_node_name` UNIQUE(`node_id`,`name`),
	CONSTRAINT `idx_nyanpass_node_ws_port` UNIQUE(`node_id`,`ws_port`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` varchar(64) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	CONSTRAINT `sessions_token_hash` PRIMARY KEY(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` varchar(64) NOT NULL,
	`value` varchar(255) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(36) NOT NULL,
	`username` varchar(32) NOT NULL,
	`role` varchar(10) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_users_username` UNIQUE(`username`)
);
--> statement-breakpoint
ALTER TABLE `agent_tasks` ADD CONSTRAINT `agent_tasks_instance_id_nyanpass_instances_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `nyanpass_instances`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aliyun_accounts` ADD CONSTRAINT `aliyun_accounts_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `domains` ADD CONSTRAINT `domains_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `domains` ADD CONSTRAINT `domains_account_id_aliyun_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `aliyun_accounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `events` ADD CONSTRAINT `events_node_id_nodes_id_fk` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `nodes` ADD CONSTRAINT `nodes_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD CONSTRAINT `nyanpass_instances_node_id_nodes_id_fk` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_node_status_created` ON `agent_tasks` (`node_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_tasks_instance_status` ON `agent_tasks` (`instance_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_domains_owner` ON `domains` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_domains_account` ON `domains` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_events_node_created` ON `events` (`node_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_events_created_at` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_nodes_owner` ON `nodes` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_nodes_last_seen_at` ON `nodes` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_nodes_provision_lease` ON `nodes` (`nyanpass_status`,`provision_lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_nyanpass_node_status` ON `nyanpass_instances` (`node_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_nyanpass_active_task` ON `nyanpass_instances` (`active_task_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires_at`);