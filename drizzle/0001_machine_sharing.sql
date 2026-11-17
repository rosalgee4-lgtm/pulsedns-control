CREATE TABLE `node_dns_records` (
	`id` varchar(36) NOT NULL,
	`node_id` varchar(36) NOT NULL,
	`owner_id` varchar(36) NOT NULL,
	`domain_name` varchar(253) NOT NULL,
	`record_v4` varchar(253),
	`record_v6` varchar(253),
	`created_at` datetime(3) NOT NULL,
	`dns_v4_key` varchar(510) GENERATED ALWAYS AS ((case when `record_v4` is not null then concat(`domain_name`, '|', `record_v4`) end)) STORED,
	`dns_v6_key` varchar(510) GENERATED ALWAYS AS ((case when `record_v6` is not null then concat(`domain_name`, '|', `record_v6`) end)) STORED,
	CONSTRAINT `node_dns_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_node_dns_records_v4` UNIQUE(`dns_v4_key`),
	CONSTRAINT `idx_node_dns_records_v6` UNIQUE(`dns_v6_key`)
);
--> statement-breakpoint
CREATE TABLE `node_shares` (
	`node_id` varchar(36) NOT NULL,
	`user_id` varchar(36) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `node_shares_node_id_user_id_pk` PRIMARY KEY(`node_id`,`user_id`)
);
--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD `owner_id` varchar(36);--> statement-breakpoint
UPDATE `nyanpass_instances` INNER JOIN `nodes` ON `nodes`.`id` = `nyanpass_instances`.`node_id` SET `nyanpass_instances`.`owner_id` = `nodes`.`owner_id`;--> statement-breakpoint
ALTER TABLE `nyanpass_instances` MODIFY `owner_id` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `node_dns_records` ADD CONSTRAINT `node_dns_records_node_id_nodes_id_fk` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `node_dns_records` ADD CONSTRAINT `node_dns_records_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `node_shares` ADD CONSTRAINT `node_shares_node_id_nodes_id_fk` FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `node_shares` ADD CONSTRAINT `node_shares_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_node_dns_records_node` ON `node_dns_records` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_node_dns_records_owner` ON `node_dns_records` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_node_dns_records_domain` ON `node_dns_records` (`domain_name`);--> statement-breakpoint
CREATE INDEX `idx_node_shares_user` ON `node_shares` (`user_id`);--> statement-breakpoint
ALTER TABLE `nyanpass_instances` ADD CONSTRAINT `nyanpass_instances_owner_id_users_id_fk` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_nyanpass_owner` ON `nyanpass_instances` (`owner_id`);