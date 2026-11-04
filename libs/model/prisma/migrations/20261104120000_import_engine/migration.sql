-- AlterTable
ALTER TABLE `import_jobs` ADD COLUMN `public_id` CHAR(36) NOT NULL,
    ADD COLUMN `file_size` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `headers` JSON NOT NULL,
    ADD COLUMN `owner_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `list_name` VARCHAR(120) NULL,
    ADD COLUMN `list_description` VARCHAR(500) NULL,
    ADD COLUMN `list_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `note` VARCHAR(500) NULL,
    ADD COLUMN `duplicate_mode` ENUM('SKIP', 'FILL_EMPTY') NOT NULL DEFAULT 'SKIP',
    ADD COLUMN `processed_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `skipped_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `failure_reason` VARCHAR(255) NULL,
    ADD COLUMN `started_at` DATETIME(3) NULL,
    MODIFY `source_id` INTEGER NULL,
    MODIFY `status` ENUM('UPLOADED', 'MAPPED', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'UPLOADED';

-- AlterTable
ALTER TABLE `import_rows` DROP COLUMN `error`,
    ADD COLUMN `message` VARCHAR(255) NULL;

-- AlterTable
ALTER TABLE `leads` ADD COLUMN `lead_score` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `score_updated_at` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `lead_lists` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `public_id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `origin_ref` VARCHAR(60) NULL,
    `created_by_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `lead_lists_public_id_key`(`public_id`),
    UNIQUE INDEX `lead_lists_name_key`(`name`),
    UNIQUE INDEX `lead_lists_origin_ref_key`(`origin_ref`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_list_members` (
    `list_id` BIGINT UNSIGNED NOT NULL,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `added_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lead_list_members_lead_id_idx`(`lead_id`),
    PRIMARY KEY (`list_id`, `lead_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_score_entries` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `points` INTEGER NOT NULL,
    `reason` VARCHAR(60) NOT NULL,
    `ref` VARCHAR(100) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lead_score_entries_lead_id_created_at_idx`(`lead_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `import_jobs_public_id_key` ON `import_jobs`(`public_id`);

-- CreateIndex
CREATE INDEX `leads_owner_id_lead_score_idx` ON `leads`(`owner_id`, `lead_score`);

-- AddForeignKey
ALTER TABLE `import_jobs` ADD CONSTRAINT `import_jobs_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_jobs` ADD CONSTRAINT `import_jobs_list_id_fkey` FOREIGN KEY (`list_id`) REFERENCES `lead_lists`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_lists` ADD CONSTRAINT `lead_lists_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_list_members` ADD CONSTRAINT `lead_list_members_list_id_fkey` FOREIGN KEY (`list_id`) REFERENCES `lead_lists`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_list_members` ADD CONSTRAINT `lead_list_members_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_score_entries` ADD CONSTRAINT `lead_score_entries_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
