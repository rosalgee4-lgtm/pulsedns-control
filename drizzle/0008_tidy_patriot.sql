INSERT INTO `events` (`node_id`, `level`, `kind`, `message`, `created_at`)
SELECT `nodes`.`id`, 'error', 'dns_ownership_conflict', '升级时发现该 DNS 记录同时由多个节点管理，已安全暂停自动同步；请检查节点配置后重新启用', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `nodes`
WHERE `nodes`.`sync_enabled` = 1
  AND `nodes`.`id` IN (
    WITH ranked_v4 AS (
      SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `domain_name`, `record_v4` ORDER BY `created_at`, `id`) AS owner_rank
      FROM `nodes`
      WHERE `sync_enabled` = 1 AND `domain_name` IS NOT NULL AND `record_v4` IS NOT NULL
    ), ranked_v6 AS (
      SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `domain_name`, `record_v6` ORDER BY `created_at`, `id`) AS owner_rank
      FROM `nodes`
      WHERE `sync_enabled` = 1 AND `domain_name` IS NOT NULL AND `record_v6` IS NOT NULL
    )
    SELECT `id` FROM ranked_v4 WHERE owner_rank > 1
    UNION
    SELECT `id` FROM ranked_v6 WHERE owner_rank > 1
  )
  AND NOT EXISTS (SELECT 1 FROM `events` WHERE `events`.`node_id` = `nodes`.`id` AND `events`.`kind` = 'dns_ownership_conflict');--> statement-breakpoint
UPDATE `nodes`
SET `sync_enabled` = 0, `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `sync_enabled` = 1 AND `id` IN (
  WITH ranked_v4 AS (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `domain_name`, `record_v4` ORDER BY `created_at`, `id`) AS owner_rank
    FROM `nodes`
    WHERE `sync_enabled` = 1 AND `domain_name` IS NOT NULL AND `record_v4` IS NOT NULL
  ), ranked_v6 AS (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `domain_name`, `record_v6` ORDER BY `created_at`, `id`) AS owner_rank
    FROM `nodes`
    WHERE `sync_enabled` = 1 AND `domain_name` IS NOT NULL AND `record_v6` IS NOT NULL
  )
  SELECT `id` FROM ranked_v4 WHERE owner_rank > 1
  UNION
  SELECT `id` FROM ranked_v6 WHERE owner_rank > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_nodes_dns_v4_owner` ON `nodes` (`domain_name`,`record_v4`) WHERE "nodes"."sync_enabled" = 1 AND "nodes"."domain_name" IS NOT NULL AND "nodes"."record_v4" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_nodes_dns_v6_owner` ON `nodes` (`domain_name`,`record_v6`) WHERE "nodes"."sync_enabled" = 1 AND "nodes"."domain_name" IS NOT NULL AND "nodes"."record_v6" IS NOT NULL;
