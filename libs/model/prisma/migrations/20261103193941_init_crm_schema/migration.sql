-- CreateTable
CREATE TABLE `audit_log` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `actor_id` BIGINT UNSIGNED NULL,
    `action` VARCHAR(60) NOT NULL,
    `entity_type` VARCHAR(40) NOT NULL,
    `entity_id` VARCHAR(64) NULL,
    `detail` JSON NULL,
    `ip` VARCHAR(45) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_log_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    INDEX `audit_log_actor_id_created_at_idx`(`actor_id`, `created_at`),
    INDEX `audit_log_action_created_at_idx`(`action`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `app_settings` (
    `key` VARCHAR(60) NOT NULL,
    `value` JSON NOT NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_assignments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `from_user_id` BIGINT UNSIGNED NULL,
    `to_user_id` BIGINT UNSIGNED NULL,
    `by_user_id` BIGINT UNSIGNED NULL,
    `method` ENUM('MANUAL', 'BULK', 'EQUAL_DISTRIBUTION', 'IMPORT', 'SYSTEM') NOT NULL,
    `reason_code` VARCHAR(40) NULL,
    `batch_id` CHAR(36) NULL,
    `source_id` INTEGER NOT NULL,
    `vsl_depth` ENUM('NONE', 'DETAILS', 'FORM', 'BOOKED') NOT NULL,
    `temperature` ENUM('HOT', 'WARM', 'COLD') NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lead_assignments_lead_id_created_at_idx`(`lead_id`, `created_at`),
    INDEX `lead_assignments_to_user_id_created_at_idx`(`to_user_id`, `created_at`),
    INDEX `lead_assignments_source_id_to_user_id_created_at_idx`(`source_id`, `to_user_id`, `created_at`),
    INDEX `lead_assignments_batch_id_idx`(`batch_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `distribution_cursors` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `scope` VARCHAR(40) NOT NULL,
    `last_user_id` BIGINT UNSIGNED NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `distribution_cursors_scope_key`(`scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `outcomes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(80) NOT NULL,
    `effect` JSON NOT NULL,
    `requires_followup` BOOLEAN NOT NULL DEFAULT false,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `outcomes_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `activities` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `opportunity_id` BIGINT UNSIGNED NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `kind` ENUM('CALL', 'WHATSAPP', 'EMAIL', 'NOTE') NOT NULL,
    `outcome_id` INTEGER NULL,
    `connected` BOOLEAN NULL,
    `attempt_no` INTEGER NULL,
    `notes` TEXT NULL,
    `next_followup_at` DATETIME(3) NULL,
    `occurred_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `activities_lead_id_occurred_at_idx`(`lead_id`, `occurred_at`),
    INDEX `activities_user_id_occurred_at_idx`(`user_id`, `occurred_at`),
    INDEX `activities_outcome_id_idx`(`outcome_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tasks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `assignee_id` BIGINT UNSIGNED NULL,
    `type` ENUM('FOLLOW_UP', 'SCHEDULED_CALL', 'DUPLICATE_REVIEW') NOT NULL,
    `status` ENUM('OPEN', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `title` VARCHAR(150) NOT NULL,
    `due_at` DATETIME(3) NOT NULL,
    `booking_ref` VARCHAR(64) NULL,
    `payload` JSON NULL,
    `created_by_id` BIGINT UNSIGNED NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `tasks_booking_ref_key`(`booking_ref`),
    INDEX `tasks_assignee_id_status_due_at_idx`(`assignee_id`, `status`, `due_at`),
    INDEX `tasks_type_status_due_at_idx`(`type`, `status`, `due_at`),
    INDEX `tasks_lead_id_idx`(`lead_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `type` ENUM('NEW_ASSIGNMENT', 'BOOKED_SLOT_UNASSIGNED', 'SLOT_SOON', 'FOLLOWUP_OVERDUE', 'DUPLICATE_REVIEW') NOT NULL,
    `lead_id` BIGINT UNSIGNED NULL,
    `message` VARCHAR(255) NOT NULL,
    `read_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_user_id_read_at_created_at_idx`(`user_id`, `read_at`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `public_id` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `email` VARCHAR(150) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `role` ENUM('BDA', 'SALES_MANAGER', 'CLOSER', 'OPS', 'ADMIN') NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `must_change_password` BOOLEAN NOT NULL DEFAULT true,
    `failed_logins` INTEGER NOT NULL DEFAULT 0,
    `locked_until` DATETIME(3) NULL,
    `last_login_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `staff_users_public_id_key`(`public_id`),
    UNIQUE INDEX `staff_users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `auth_sessions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `family_id` CHAR(36) NOT NULL,
    `user_agent` VARCHAR(255) NULL,
    `ip` VARCHAR(45) NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `auth_sessions_token_hash_key`(`token_hash`),
    INDEX `auth_sessions_user_id_idx`(`user_id`),
    INDEX `auth_sessions_family_id_idx`(`family_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `source_credentials` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(60) NOT NULL,
    `system` ENUM('WORKR', 'VSL_FORM', 'VSL_BOOKING') NOT NULL,
    `key_prefix` CHAR(8) NOT NULL,
    `key_hash` CHAR(64) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `last_used_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revoked_at` DATETIME(3) NULL,

    UNIQUE INDEX `source_credentials_name_key`(`name`),
    UNIQUE INDEX `source_credentials_key_hash_key`(`key_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_jobs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `created_by_id` BIGINT UNSIGNED NOT NULL,
    `file_name` VARCHAR(200) NOT NULL,
    `source_id` INTEGER NOT NULL,
    `column_mapping` JSON NULL,
    `status` ENUM('UPLOADED', 'MAPPED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'UPLOADED',
    `total_rows` INTEGER NOT NULL DEFAULT 0,
    `created_count` INTEGER NOT NULL DEFAULT 0,
    `matched_count` INTEGER NOT NULL DEFAULT 0,
    `error_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,

    INDEX `import_jobs_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `import_rows` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `job_id` BIGINT UNSIGNED NOT NULL,
    `row_no` INTEGER NOT NULL,
    `raw` JSON NULL,
    `status` ENUM('CREATED', 'MATCHED', 'SKIPPED', 'ERROR') NULL,
    `lead_id` BIGINT UNSIGNED NULL,
    `error` VARCHAR(255) NULL,

    INDEX `import_rows_job_id_status_idx`(`job_id`, `status`),
    UNIQUE INDEX `import_rows_job_id_row_no_key`(`job_id`, `row_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inbox_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `event_id` VARCHAR(64) NOT NULL,
    `source` ENUM('WORKR', 'VSL_FORM', 'VSL_BOOKING') NOT NULL,
    `type` VARCHAR(40) NOT NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `payload` JSON NULL,
    `status` ENUM('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED', 'DEAD') NOT NULL DEFAULT 'RECEIVED',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` VARCHAR(500) NULL,
    `lead_id` BIGINT UNSIGNED NULL,
    `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processed_at` DATETIME(3) NULL,

    INDEX `inbox_events_status_received_at_idx`(`status`, `received_at`),
    INDEX `inbox_events_lead_id_idx`(`lead_id`),
    UNIQUE INDEX `inbox_events_source_event_id_key`(`source`, `event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reconciliation_cursors` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `source` ENUM('WORKR', 'VSL_FORM', 'VSL_BOOKING') NOT NULL,
    `last_seen_at` DATETIME(3) NULL,
    `last_run_at` DATETIME(3) NULL,
    `last_status` VARCHAR(40) NULL,

    UNIQUE INDEX `reconciliation_cursors_source_key`(`source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leads` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `public_id` CHAR(36) NOT NULL,
    `full_name` VARCHAR(150) NOT NULL,
    `email` VARCHAR(150) NULL,
    `phone_e164` VARCHAR(16) NULL,
    `phone_last10` CHAR(10) NULL,
    `current_company` VARCHAR(255) NULL,
    `current_ctc` VARCHAR(100) NULL,
    `graduation_year` CHAR(4) NULL,
    `domain` VARCHAR(255) NULL,
    `user_type` ENUM('WORKING_PROFESSIONAL', 'STUDENT', 'UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
    `lifecycle_stage` ENUM('MARKETING_LEAD', 'ENGAGED_LEAD', 'PROSPECT', 'ENROLLED', 'LEARNER_ONBOARDED', 'NOT_INTERESTED', 'EXHAUSTED_NOT_CONNECTED') NOT NULL DEFAULT 'MARKETING_LEAD',
    `owner_id` BIGINT UNSIGNED NULL,
    `first_source_id` INTEGER NOT NULL,
    `vsl_depth` ENUM('NONE', 'DETAILS', 'FORM', 'BOOKED') NOT NULL DEFAULT 'NONE',
    `form_score` INTEGER NULL,
    `temperature` ENUM('HOT', 'WARM', 'COLD') NULL,
    `priority_rank` INTEGER NOT NULL DEFAULT 0,
    `do_not_contact` BOOLEAN NOT NULL DEFAULT false,
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `custom` JSON NULL,
    `edited_fields` JSON NULL,
    `merged_into_id` BIGINT UNSIGNED NULL,
    `captured_at` DATETIME(3) NOT NULL,
    `first_touch_at` DATETIME(3) NULL,
    `last_activity_at` DATETIME(3) NULL,
    `next_followup_at` DATETIME(3) NULL,
    `anonymised_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `leads_public_id_key`(`public_id`),
    INDEX `leads_email_idx`(`email`),
    INDEX `leads_phone_last10_idx`(`phone_last10`),
    INDEX `leads_owner_id_lifecycle_stage_idx`(`owner_id`, `lifecycle_stage`),
    INDEX `leads_owner_id_next_followup_at_idx`(`owner_id`, `next_followup_at`),
    INDEX `leads_owner_id_priority_rank_idx`(`owner_id`, `priority_rank`),
    INDEX `leads_lifecycle_stage_captured_at_idx`(`lifecycle_stage`, `captured_at`),
    INDEX `leads_first_source_id_captured_at_idx`(`first_source_id`, `captured_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_identities` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `type` ENUM('EMAIL', 'PHONE') NOT NULL,
    `value` VARCHAR(150) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lead_identities_lead_id_idx`(`lead_id`),
    UNIQUE INDEX `lead_identities_type_value_key`(`type`, `value`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_sources` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(80) NOT NULL,
    `group` ENUM('WORKR', 'VSL', 'META', 'ORGANIC', 'IMPORT', 'REFERRAL', 'OTHER') NOT NULL,
    `match_rule` JSON NULL,
    `match_order` INTEGER NOT NULL DEFAULT 100,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `lead_sources_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `touchpoints` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `source_id` INTEGER NOT NULL,
    `kind` ENUM('SIGNUP', 'DETAILS', 'FORM', 'BOOKING', 'IMPORT', 'MANUAL') NOT NULL,
    `external_ref` VARCHAR(100) NULL,
    `payload` JSON NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `touchpoints_external_ref_key`(`external_ref`),
    INDEX `touchpoints_lead_id_occurred_at_idx`(`lead_id`, `occurred_at`),
    INDEX `touchpoints_source_id_occurred_at_idx`(`source_id`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `form_responses` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `form_slug` VARCHAR(100) NOT NULL,
    `submission_ref` VARCHAR(64) NOT NULL,
    `score` INTEGER NULL,
    `temperature` ENUM('HOT', 'WARM', 'COLD') NULL,
    `answers` JSON NOT NULL,
    `submitted_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `form_responses_submission_ref_key`(`submission_ref`),
    INDEX `form_responses_lead_id_idx`(`lead_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bookings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `booking_ref` VARCHAR(64) NOT NULL,
    `submission_ref` VARCHAR(64) NOT NULL,
    `slot_start_at` DATETIME(3) NOT NULL,
    `slot_label` VARCHAR(100) NOT NULL,
    `status` ENUM('CONFIRMED', 'CANCELLED', 'COMPLETED') NOT NULL,
    `cancel_source` VARCHAR(30) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `bookings_booking_ref_key`(`booking_ref`),
    INDEX `bookings_lead_id_idx`(`lead_id`),
    INDEX `bookings_slot_start_at_status_idx`(`slot_start_at`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_field_definitions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(50) NOT NULL,
    `label` VARCHAR(100) NOT NULL,
    `type` ENUM('TEXT', 'NUMBER', 'DATE', 'SELECT', 'MULTISELECT', 'BOOLEAN') NOT NULL,
    `options` JSON NULL,
    `is_required` BOOLEAN NOT NULL DEFAULT false,
    `visible_roles` JSON NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `custom_field_definitions_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `saved_views` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `filters` JSON NOT NULL,
    `is_shared` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `saved_views_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `opportunities` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `public_id` CHAR(36) NOT NULL,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `stage` ENUM('CALL_1_PENDING', 'CALL_1', 'TEST', 'CALL_2', 'PSYCHOMETRIC_SESSION', 'DECISION_OBJECTION', 'PAYMENT_FINANCING', 'CLOSED_WON') NOT NULL DEFAULT 'CALL_1_PENDING',
    `status` ENUM('OPEN', 'WON', 'LOST') NOT NULL DEFAULT 'OPEN',
    `open_lead_id` BIGINT UNSIGNED NULL,
    `owner_id` BIGINT UNSIGNED NULL,
    `scheduled_call_at` DATETIME(3) NULL,
    `lost_reason_id` INTEGER NULL,
    `lost_note` VARCHAR(255) NULL,
    `opened_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `stage_changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `opportunities_public_id_key`(`public_id`),
    UNIQUE INDEX `opportunities_open_lead_id_key`(`open_lead_id`),
    INDEX `opportunities_lead_id_idx`(`lead_id`),
    INDEX `opportunities_stage_status_idx`(`stage`, `status`),
    INDEX `opportunities_owner_id_status_idx`(`owner_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `opportunity_stage_changes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `opportunity_id` BIGINT UNSIGNED NOT NULL,
    `from_stage` ENUM('CALL_1_PENDING', 'CALL_1', 'TEST', 'CALL_2', 'PSYCHOMETRIC_SESSION', 'DECISION_OBJECTION', 'PAYMENT_FINANCING', 'CLOSED_WON') NULL,
    `to_stage` ENUM('CALL_1_PENDING', 'CALL_1', 'TEST', 'CALL_2', 'PSYCHOMETRIC_SESSION', 'DECISION_OBJECTION', 'PAYMENT_FINANCING', 'CLOSED_WON') NOT NULL,
    `changed_by_id` BIGINT UNSIGNED NULL,
    `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `opportunity_stage_changes_opportunity_id_changed_at_idx`(`opportunity_id`, `changed_at`),
    INDEX `opportunity_stage_changes_to_stage_changed_at_idx`(`to_stage`, `changed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lost_reasons` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(80) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `lost_reasons_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `lead_id` BIGINT UNSIGNED NOT NULL,
    `type` VARCHAR(60) NOT NULL,
    `actor_type` ENUM('SYSTEM', 'USER', 'SOURCE') NOT NULL,
    `actor_id` BIGINT UNSIGNED NULL,
    `data` JSON NULL,
    `occurred_at` DATETIME(3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lead_events_lead_id_occurred_at_idx`(`lead_id`, `occurred_at`),
    INDEX `lead_events_type_occurred_at_idx`(`type`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `audit_log` ADD CONSTRAINT `audit_log_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `app_settings` ADD CONSTRAINT `app_settings_updated_by_fkey` FOREIGN KEY (`updated_by`) REFERENCES `staff_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_assignments` ADD CONSTRAINT `lead_assignments_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_assignments` ADD CONSTRAINT `lead_assignments_from_user_id_fkey` FOREIGN KEY (`from_user_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_assignments` ADD CONSTRAINT `lead_assignments_to_user_id_fkey` FOREIGN KEY (`to_user_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_assignments` ADD CONSTRAINT `lead_assignments_by_user_id_fkey` FOREIGN KEY (`by_user_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_assignments` ADD CONSTRAINT `lead_assignments_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `lead_sources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `distribution_cursors` ADD CONSTRAINT `distribution_cursors_last_user_id_fkey` FOREIGN KEY (`last_user_id`) REFERENCES `staff_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activities` ADD CONSTRAINT `activities_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activities` ADD CONSTRAINT `activities_opportunity_id_fkey` FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activities` ADD CONSTRAINT `activities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `activities` ADD CONSTRAINT `activities_outcome_id_fkey` FOREIGN KEY (`outcome_id`) REFERENCES `outcomes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assignee_id_fkey` FOREIGN KEY (`assignee_id`) REFERENCES `staff_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `staff_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `staff_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_jobs` ADD CONSTRAINT `import_jobs_created_by_id_fkey` FOREIGN KEY (`created_by_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_jobs` ADD CONSTRAINT `import_jobs_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `lead_sources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_rows` ADD CONSTRAINT `import_rows_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `import_rows` ADD CONSTRAINT `import_rows_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inbox_events` ADD CONSTRAINT `inbox_events_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `leads_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `staff_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `leads_first_source_id_fkey` FOREIGN KEY (`first_source_id`) REFERENCES `lead_sources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `leads_merged_into_id_fkey` FOREIGN KEY (`merged_into_id`) REFERENCES `leads`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_identities` ADD CONSTRAINT `lead_identities_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `touchpoints` ADD CONSTRAINT `touchpoints_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `touchpoints` ADD CONSTRAINT `touchpoints_source_id_fkey` FOREIGN KEY (`source_id`) REFERENCES `lead_sources`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `form_responses` ADD CONSTRAINT `form_responses_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bookings` ADD CONSTRAINT `bookings_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `saved_views` ADD CONSTRAINT `saved_views_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `staff_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `opportunities` ADD CONSTRAINT `opportunities_lost_reason_id_fkey` FOREIGN KEY (`lost_reason_id`) REFERENCES `lost_reasons`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `opportunity_stage_changes` ADD CONSTRAINT `opportunity_stage_changes_opportunity_id_fkey` FOREIGN KEY (`opportunity_id`) REFERENCES `opportunities`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `opportunity_stage_changes` ADD CONSTRAINT `opportunity_stage_changes_changed_by_id_fkey` FOREIGN KEY (`changed_by_id`) REFERENCES `staff_users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_events` ADD CONSTRAINT `lead_events_lead_id_fkey` FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
