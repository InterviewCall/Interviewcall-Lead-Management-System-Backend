-- CreateIndex
CREATE INDEX `leads_captured_at_id_idx` ON `leads`(`captured_at`, `id`);

-- CreateIndex
CREATE INDEX `opportunities_status_scheduled_call_at_idx` ON `opportunities`(`status`, `scheduled_call_at`);

-- CreateIndex
CREATE INDEX `activities_kind_occurred_at_idx` ON `activities`(`kind`, `occurred_at`);
