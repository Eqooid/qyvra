-- Add owner-entered metadata without rewriting existing documents or file versions.
ALTER TABLE "documents" ADD COLUMN "description" VARCHAR(2000);

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_description_check" CHECK (
    "description" IS NULL OR (
      char_length("description") > 0
      AND "description" = btrim("description")
      AND "description" !~ '[[:cntrl:]]'
    )
  );
