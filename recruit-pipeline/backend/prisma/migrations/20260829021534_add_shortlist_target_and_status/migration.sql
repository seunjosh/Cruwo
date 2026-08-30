-- AlterTable
ALTER TABLE `Application` ADD COLUMN `interviewEmailBody` TEXT NULL,
    ADD COLUMN `interviewEmailSubject` TEXT NULL;

-- AlterTable
ALTER TABLE `Job` ADD COLUMN `shortlistTarget` INTEGER NULL,
    ADD COLUMN `status` VARCHAR(191) NOT NULL DEFAULT 'open';
