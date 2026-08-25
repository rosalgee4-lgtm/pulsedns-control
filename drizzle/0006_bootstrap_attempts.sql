ALTER TABLE `nodes` ADD `provision_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `nodes` ADD `provision_attempt_id` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `provision_lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `nodes` ADD `dns_operation_id` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `dns_operation_expires_at` integer;--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD `bootstrap_generation` integer;--> statement-breakpoint
CREATE INDEX `idx_nodes_provision_lease` ON `nodes` (`nyanpass_status`,`provision_lease_expires_at`);--> statement-breakpoint
UPDATE `nodes` SET `nyanpass_status` = 'uncertain', `provision_generation` = 1 WHERE `nyanpass_status` = 'provisioning' AND `provision_attempt_id` IS NULL;--> statement-breakpoint
UPDATE `nyanpass_instances` SET `bootstrap_generation` = 1 WHERE `config_revision` = 0 AND `status` IN ('bootstrap', 'uncertain') AND `bootstrap_generation` IS NULL;
