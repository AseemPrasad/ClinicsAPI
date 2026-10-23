-- CreateEnum
CREATE TYPE "AppointmentSlotStatus" AS ENUM ('available', 'cancelled');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('confirmed', 'cancelled');

-- CreateTable
CREATE TABLE "clinics" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "clinics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointment_slots" (
    "id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "AppointmentSlotStatus" NOT NULL DEFAULT 'available',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),
    CONSTRAINT "appointment_slots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "appointment_slots_valid_time_range" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "appointment_slots_cancelled_at_consistency" CHECK (
      ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL)
      OR ("status" = 'available' AND "cancelled_at" IS NULL)
    )
);

CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'confirmed',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(6),
    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "bookings_cancelled_at_consistency" CHECK (
      ("status" = 'cancelled' AND "cancelled_at" IS NOT NULL)
      OR ("status" = 'confirmed' AND "cancelled_at" IS NULL)
    )
);

CREATE INDEX "appointment_slots_clinic_id_starts_at_id_idx"
ON "appointment_slots"("clinic_id", "starts_at", "id");

CREATE INDEX "appointment_slots_clinic_id_status_starts_at_id_idx"
ON "appointment_slots"("clinic_id", "status", "starts_at", "id");

CREATE INDEX "bookings_slot_id_idx" ON "bookings"("slot_id");
CREATE INDEX "bookings_patient_id_created_at_idx" ON "bookings"("patient_id", "created_at");

CREATE UNIQUE INDEX "one_active_booking_per_slot"
ON "bookings" ("slot_id")
WHERE "status" = 'confirmed';

ALTER TABLE "appointment_slots"
ADD CONSTRAINT "appointment_slots_clinic_id_fkey"
FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bookings"
ADD CONSTRAINT "bookings_slot_id_fkey"
FOREIGN KEY ("slot_id") REFERENCES "appointment_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
