ALTER TABLE `nodes` ADD `agent_upgrade_id` varchar(36);--> statement-breakpoint
ALTER TABLE `nodes` ADD `agent_upgrade_status` varchar(12);--> statement-breakpoint
ALTER TABLE `nodes` ADD `agent_upgrade_target_version` varchar(30);--> statement-breakpoint
ALTER TABLE `nodes` ADD `agent_upgrade_requested_at` datetime(3);--> statement-breakpoint
ALTER TABLE `nodes` ADD `agent_upgrade_started_at` datetime(3);