-- Browser uploads encode derivatives with canvas, which cannot reliably emit
-- AVIF. Recording the format per media lets both pipelines coexist.
ALTER TABLE media ADD COLUMN drv_ext TEXT NOT NULL DEFAULT 'avif';
