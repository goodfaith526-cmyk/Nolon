-- CreateTable
CREATE TABLE "customer_stages" (
    "code" VARCHAR(30) NOT NULL,
    "name_ar" VARCHAR(100) NOT NULL,
    "name_en" VARCHAR(100) NOT NULL,
    "sort_order" SMALLINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "customer_stages_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "shipment_status_stages" (
    "status" "shipment_status" NOT NULL,
    "stage_code" VARCHAR(30) NOT NULL,

    CONSTRAINT "shipment_status_stages_pkey" PRIMARY KEY ("status")
);

-- AddForeignKey
ALTER TABLE "shipment_status_stages" ADD CONSTRAINT "shipment_status_stages_stage_code_fkey" FOREIGN KEY ("stage_code") REFERENCES "customer_stages"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Plan 09 section 3: the owner's nine stations, and the mapping the agent project proposed.
INSERT INTO "customer_stages" ("code", "name_ar", "name_en", "sort_order") VALUES
    ('BOOKED', 'حجز مبدئي', 'Booking received', 1),
    ('CONFIRMED', 'مؤكد لدى منفذ الشحن', 'Confirmed by the shipping outlet', 2),
    ('AT_ORIGIN_HUB', 'في مركز التجميع', 'At the collection hub', 3),
    ('AT_SEA', 'في الطريق البحري', 'At sea', 4),
    ('AT_PORT', 'في الميناء بانتظار التخليص', 'At the port, awaiting clearance', 5),
    ('AT_CENTRAL_HUB', 'في مركز التوزيع المركزي', 'At the central distribution hub', 6),
    ('ON_ROAD', 'في الطريق البري إلى المدينة', 'On the road to the city', 7),
    ('AT_DESTINATION_HUB', 'في مركز التوزيع في مدينة المستلم', 'At the distribution hub in the receiver''s city', 8),
    ('DELIVERED', 'تم التسليم', 'Delivered', 9);

INSERT INTO "shipment_status_stages" ("status", "stage_code") VALUES
    ('CREATED', 'CONFIRMED'),
    ('PICKUP_SCHEDULED', 'CONFIRMED'),
    ('RECEIVED_ORIGIN_WAREHOUSE', 'AT_ORIGIN_HUB'),
    ('CONSOLIDATED', 'AT_ORIGIN_HUB'),
    ('LOADED', 'AT_SEA'),
    ('DEPARTED', 'AT_SEA'),
    ('IN_TRANSIT', 'AT_SEA'),
    ('ARRIVED_PORT', 'AT_PORT'),
    ('CUSTOMS_IN_PROGRESS', 'AT_PORT'),
    ('CUSTOMS_CLEARED', 'AT_CENTRAL_HUB'),
    ('TRIP_SCHEDULED', 'AT_CENTRAL_HUB'),
    ('ROAD_DEPARTED', 'ON_ROAD'),
    ('ROAD_IN_TRANSIT', 'ON_ROAD'),
    ('ROAD_ARRIVED', 'AT_DESTINATION_HUB'),
    ('RECEIVED_DESTINATION_WAREHOUSE', 'AT_DESTINATION_HUB'),
    ('OUT_FOR_DELIVERY', 'AT_DESTINATION_HUB'),
    ('DELIVERED', 'DELIVERED'),
    ('CLOSED', 'DELIVERED');
