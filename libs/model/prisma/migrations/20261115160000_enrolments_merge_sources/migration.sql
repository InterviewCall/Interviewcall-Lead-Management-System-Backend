-- An opportunity can be closed because its lead was merged into another.
ALTER TABLE `opportunities` MODIFY `status` ENUM('OPEN', 'WON', 'LOST', 'MERGED') NOT NULL DEFAULT 'OPEN';

-- CreateTable
CREATE TABLE `enrolments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `opportunity_id` BIGINT UNSIGNED NOT NULL,
    `program` VARCHAR(120) NULL,
    `fee_amount` INTEGER NOT NULL,
    `amount_collected` INTEGER NOT NULL DEFAULT 0,
    `payment_mode` ENUM('FULL', 'EMI', 'LOAN', 'PART') NOT NULL,
    `note` VARCHAR(255) NULL,
    `recorded_by_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `enrolments_opportunity_id_key`(`opportunity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `enrolments` ADD CONSTRAINT `enrolments_opportunity_id_fkey` FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `enrolments` ADD CONSTRAINT `enrolments_recorded_by_id_fkey` FOREIGN KEY (`recorded_by_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Sources for leads added by hand (kept if an admin already made them).
INSERT IGNORE INTO `lead_sources` (`name`, `group`, `match_order`, `is_active`) VALUES
    ('Referral', 'REFERRAL', 800, true),
    ('Walk-in', 'OTHER', 800, true),
    ('Inbound call', 'OTHER', 800, true);
