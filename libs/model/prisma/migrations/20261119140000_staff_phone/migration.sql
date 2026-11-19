-- AlterTable
ALTER TABLE `staff_users` ADD COLUMN `phone` VARCHAR(20) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `staff_users_phone_key` ON `staff_users`(`phone`);
