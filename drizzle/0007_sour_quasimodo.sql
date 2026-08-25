ALTER TABLE `nodes` ADD `bootstrap_payload_ciphertext` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `bootstrap_download_token_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_nodes_bootstrap_download_token_hash` ON `nodes` (`bootstrap_download_token_hash`);