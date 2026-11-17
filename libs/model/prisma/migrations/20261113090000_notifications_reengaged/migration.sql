-- AlterTable
ALTER TABLE `notifications` MODIFY `type` ENUM('NEW_ASSIGNMENT', 'BOOKED_SLOT_UNASSIGNED', 'SLOT_SOON', 'FOLLOWUP_OVERDUE', 'DUPLICATE_REVIEW', 'LEAD_REENGAGED') NOT NULL,
    ADD COLUMN `task_id` BIGINT UNSIGNED NULL;

-- CreateIndex
CREATE UNIQUE INDEX `notifications_user_id_type_task_id_key` ON `notifications`(`user_id`, `type`, `task_id`);

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
