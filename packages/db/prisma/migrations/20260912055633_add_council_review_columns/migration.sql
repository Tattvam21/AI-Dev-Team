-- AlterEnum
ALTER TYPE "ReviewVerdict" ADD VALUE 'disputed';

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "council_member" INTEGER,
ADD COLUMN     "is_final_verdict" BOOLEAN NOT NULL DEFAULT true;
