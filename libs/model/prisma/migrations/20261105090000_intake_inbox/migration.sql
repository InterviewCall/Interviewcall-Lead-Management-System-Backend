-- AlterTable
ALTER TABLE `inbox_events` ADD COLUMN `outcome` VARCHAR(20) NULL,
    ADD COLUMN `next_attempt_at` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `inbox_events_status_next_attempt_at_idx` ON `inbox_events`(`status`, `next_attempt_at`);
