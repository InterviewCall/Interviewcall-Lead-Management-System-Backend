-- AlterTable
ALTER TABLE `opportunities`
    ADD COLUMN `test_on` DATE NULL,
    ADD COLUMN `psychometric_on` DATE NULL,
    ADD COLUMN `won_on` DATE NULL;

-- Deals that were already won get the day they were closed (India's calendar).
UPDATE `opportunities` SET `won_on` = DATE(CONVERT_TZ(`closed_at`, '+00:00', '+05:30')) WHERE `status` = 'WON' AND `closed_at` IS NOT NULL AND `won_on` IS NULL;
