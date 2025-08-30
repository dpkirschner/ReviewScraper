# batch_label_reviews_v3.py (Python ≥3.8)
# ------------------------------------------------------------
# Includes improved error handling and logging.
# Example:
#   export OPENAI_API_KEY=sk-...
#   python batch_label_reviews_v3.py \
#       --reviews sample_data.csv \
#       --review_text_col "Review Text" \
#       --review_id_col "Review ID" \
#       --taxonomy taxonomy.json \
#       --output labeled_reviews.csv \
#       --model gpt-4.1-mini \
#       --batch_size 20 \
#       --sleep 2
# ------------------------------------------------------------
import csv
import json
import os
import time
import argparse
import io
import sys
import traceback # Import traceback module
from openai import ( # Import specific errors
    OpenAI,
    RateLimitError,
    BadRequestError,
    APIError,
    APIConnectionError,
    AuthenticationError
)
from pathlib import Path
from textwrap import dedent
from dotenv import load_dotenv

# ---------- CLI ----------
p = argparse.ArgumentParser(description="Label App Store reviews using OpenAI API based on a taxonomy.")
p.add_argument("--reviews", required=True, help="Path to the raw App Store CSV file")
p.add_argument("--review_text_col", default="Review Text", help="Column name for review text in the input CSV")
p.add_argument("--review_id_col", default="Review ID", help="Column name for review ID in the input CSV")
p.add_argument("--taxonomy", required=True, help="Path to the taxonomy.json file")
p.add_argument("--output", required=True, help="Path for the destination CSV with labels")
p.add_argument("--model", default="gpt-4.1-mini", help="OpenAI model to use")
p.add_argument("--batch_size", type=int, default=20, help="Number of reviews to process per API call")
p.add_argument("--sleep", type=float, default=2.0, help="Seconds to sleep between API calls")
p.add_argument("--timeout", type=int, default=120, help="Timeout in seconds for the API call")
args = p.parse_args()

# ---------- Initialize OpenAI Client ----------
load_dotenv(override=True) # Use override=True to ensure .env takes precedence
api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    sys.exit("❌ Error: Set OPENAI_API_KEY environment variable or place it in a .env file.")
try:
    client = OpenAI(api_key=api_key, timeout=args.timeout)
    # Test connection/key (optional but recommended)
    # client.models.list()
    # print("✅ OpenAI client initialized successfully.")
except Exception as e:
     sys.exit(f"❌ Error initializing OpenAI client: {e}")


# ---------- Load taxonomy & reviews ----------
try:
    taxonomy = Path(args.taxonomy).read_text(encoding="utf-8")
    # Validate if taxonomy is valid JSON (optional)
    # json.loads(taxonomy)
except FileNotFoundError:
    sys.exit(f"❌ Error: Taxonomy file not found at {args.taxonomy}")
except json.JSONDecodeError:
     sys.exit(f"❌ Error: Taxonomy file {args.taxonomy} is not valid JSON.")
except Exception as e:
    sys.exit(f"❌ Error loading taxonomy file {args.taxonomy}: {e}")


meta_rows = []          # list[dict] – one per review
try:
    with open(args.reviews, mode="r", newline="", encoding="utf-8-sig") as f: # Use utf-8-sig for potential BOM
        reader = csv.DictReader(f)
        if args.review_id_col not in reader.fieldnames or args.review_text_col not in reader.fieldnames:
             sys.exit(f"❌ Error: Required columns '{args.review_id_col}' or '{args.review_text_col}' not found in {args.reviews}. Available columns: {reader.fieldnames}")

        for i, r in enumerate(reader):
            review_text = r.get(args.review_text_col, "")
            review_id = r.get(args.review_id_col, "")

            # Basic validation
            if not isinstance(review_id, str) or not review_id.strip():
                 print(f"⚠️ Skipping row {i+2} due to missing or invalid '{args.review_id_col}': {review_id}", file=sys.stderr)
                 continue
            if not isinstance(review_text, str) or not review_text.strip():
                print(f"⚠️ Skipping row {i+2} (ID: {review_id}) due to missing or invalid '{args.review_text_col}'", file=sys.stderr)
                continue

            meta_rows.append({
                "review_id":   review_id.strip(),
                "country":     r.get("Country", ""),
                "username":    r.get("User Name", ""),
                "app_version": r.get("App Version", ""),
                "rating":      r.get("Rating", ""),
                "review_title":r.get("Review Title", ""),
                "review_text": review_text.strip(),
                "review_date": r.get("Review Date", ""), # Use get for potential missing date
                "helpful_votes": r.get("Helpful Votes", "")
            })
except FileNotFoundError:
     sys.exit(f"❌ Error: Reviews file not found at {args.reviews}")
except Exception as e:
    sys.exit(f"❌ Error loading reviews file {args.reviews}: {e}")


if not meta_rows:
     sys.exit(f"❌ Error: No valid reviews loaded from {args.reviews}. Check file content and column names (--review_id_col, --review_text_col).")

print(f"✅ Loaded {len(meta_rows):,} reviews from {args.reviews}")

# ---------- Prompt scaffolding ----------
SYSTEM_MSG = (
    "You are a meticulous analyst focused on extracting structured data. "
    "Return ONLY raw CSV lines matching the requested format, without any headers, explanations, or commentary."
)

LABEL_PROMPT_TEMPLATE = dedent("""
    Analyze the user reviews provided below based ONLY on the following taxonomy:
    ```json
    {taxonomy}
    ```

    For EACH review object provided in the input, identify ONE SINGLE primary theme, its sentiment, severity, whether it's a feature request, and extract a concise quote. Return ONE SINGLE CSV line per input review object, formatted exactly as:
    review_id,theme,sentiment,severity,feature_request,direct_quote

    **Formatting Rules & Constraints:**
    * Use the exact `review_id` from the input object.
    * `theme` MUST be one of the exact "name" values from the provided taxonomy. If no theme fits well, use "General Feedback".
    * `sentiment` MUST be one of: positive | neutral | negative.
    * `severity` MUST be an integer from 1 (minor annoyance) to 5 (critical issue/app unusable). Use 1 for positive/neutral sentiment.
    * `feature_request` MUST be 'Y' or 'N'. Set to 'Y' if the user explicitly suggests adding or improving a feature.
    * `direct_quote` MUST be an exact quote from the review text, maximum 20 words, enclosed in double quotes (""). Escape any internal double quotes with another double quote (""). If no suitable quote, use "".
    * Output ONLY the raw CSV lines, one per input object. DO NOT include headers or any other text.

    **Input Reviews (delimiter between reviews is '###'):**
    {batch_block}
""").strip()

# ---------- Prepare Output File ----------
output_path = Path(args.output)
output_existed = output_path.exists()
processed_ids = set()

# Read existing IDs if the file exists to allow resuming
if output_existed:
    try:
        with open(output_path, "r", newline="", encoding="utf-8-sig") as f_read:
            reader = csv.DictReader(f_read)
            if "review_id" not in reader.fieldnames:
                 print(f"⚠️ Warning: Output file {args.output} exists but lacks 'review_id' column. Overwriting may occur if script failed previously.")
            else:
                 for row in reader:
                     processed_ids.add(row["review_id"])
        print(f"✅ Output file {args.output} exists. Found {len(processed_ids)} already processed review IDs.")
    except Exception as e:
        print(f"⚠️ Warning: Could not read existing output file {args.output}. Will append, but duplicates might occur. Error: {e}")


# Open file in append mode and write header if needed
try:
    output_file = open(output_path, "a", newline="", encoding="utf-8")
    writer = csv.writer(output_file)
    if not output_existed or os.path.getsize(output_path) == 0:
        writer.writerow([
            "review_id","country","username","app_version","rating",
            "review_title","review_text","review_date","helpful_votes",
            "theme","sentiment","severity","feature_request","direct_quote"
        ])
        output_file.flush() # Ensure header is written immediately
except Exception as e:
    sys.exit(f"❌ Error opening output file {args.output} for writing: {e}")

# ---------- Helper to append combined rows ----------
def append_batch_results(csv_response_chunk, batch_metadata_map):
    """Parses AI CSV response and writes combined rows to the output file."""
    reader = csv.reader(io.StringIO(csv_response_chunk))
    rows_written_count = 0
    try:
        for model_row in reader:
            if not model_row or len(model_row) != 6: # Expecting 6 fields from AI
                 print(f"⚠️ Skipping malformed row from AI: {model_row}")
                 continue

            rid = model_row[0].strip()
            meta = batch_metadata_map.get(rid) # Use dict.get for safety

            if meta is None:
                print(f"⚠️ Could not find metadata for review_id '{rid}' returned by AI. Skipping row: {model_row}")
                continue

            # Write the combined row
            writer.writerow([
                meta["review_id"], meta["country"], meta["username"],
                meta["app_version"], meta["rating"], meta["review_title"],
                meta["review_text"], meta["review_date"], meta["helpful_votes"],
                *model_row[1:] # theme, sentiment, severity, feature_request, direct_quote
            ])
            processed_ids.add(rid) # Track successfully processed ID
            rows_written_count += 1
        output_file.flush() # Flush writes after processing each batch chunk
        return rows_written_count
    except csv.Error as csve:
         print(f"⚠️ CSV parsing error in AI response chunk. Error: {csve}")
         print(f"   Problematic chunk (first 500 chars): {csv_response_chunk[:500]}")
         return 0 # Indicate no rows were successfully written from this chunk
    except Exception as e:
         print(f"⚠️ Unexpected error during append_batch_results:")
         traceback.print_exc()
         return 0


# ---------- Main loop ----------
total_processed_count = 0
error_count = 0

print(f"\n🚀 Starting API calls with model '{args.model}', batch size {args.batch_size}...")
try:
    for start in range(0, len(meta_rows), args.batch_size):
        batch_meta_list = meta_rows[start : start + args.batch_size]

        # Filter out already processed reviews in this batch
        batch_to_process = [m for m in batch_meta_list if m["review_id"] not in processed_ids]

        if not batch_to_process:
            print(f"⏩ Batch starting {start}: All reviews already processed. Skipping.")
            continue

        # Create a map for faster lookup in append_batch_results
        batch_meta_map = {m["review_id"]: m for m in batch_to_process}
        current_batch_number = start // args.batch_size + 1
        num_reviews_in_batch = len(batch_to_process)

        print(f"\n--- Processing Batch {current_batch_number} (Reviews {start+1}-{min(start+args.batch_size, len(meta_rows))}, {num_reviews_in_batch} to process) ---")
        # print(f"   Review IDs: {[m['review_id'] for m in batch_to_process]}") # Uncomment for debugging

        # Build JSON objects for the prompt
        objs = [
            # Ensure review_id is always string, handle potential non-string data
            json.dumps({"id": str(m["review_id"]), "text": m["review_text"]}, ensure_ascii=False)
            for m in batch_to_process
        ]
        batch_block = "\n###\n".join(objs)

        user_prompt = LABEL_PROMPT_TEMPLATE.format(
            taxonomy=taxonomy,
            batch_block=batch_block
        )

        try:
            start_time = time.monotonic()
            resp = client.chat.completions.create(
                model=args.model,
                messages=[{"role":"system","content":SYSTEM_MSG},
                          {"role":"user","content":user_prompt}],
                temperature=0.1, # Lower temperature for more deterministic CSV output
                # timeout=args.timeout, # Timeout is part of client init now
            )
            end_time = time.monotonic()
            duration = end_time - start_time
            csv_chunk = resp.choices[0].message.content.strip()

            # --- Basic Response Validation ---
            if not csv_chunk or not isinstance(csv_chunk, str):
                 print(f"⚠️ Invalid or empty response content from AI for batch {current_batch_number}. Skipping.")
                 error_count += 1
                 continue # Skip to next batch

            # Further validation: Check if it looks like CSV (simple check)
            # Count lines vs expected lines, check for commas
            lines_in_chunk = csv_chunk.count('\n') + 1
            if lines_in_chunk < num_reviews_in_batch * 0.8: # Allow for some potential AI misses
                 print(f"⚠️ AI response for batch {current_batch_number} seems incomplete ({lines_in_chunk} lines vs {num_reviews_in_batch} expected). Processing what's available.")
                 # print(f"   Response received:\n{csv_chunk}") # Uncomment for debugging

            # --- Append results ---
            written_count = append_batch_results(csv_chunk, batch_meta_map)
            if written_count > 0:
                 print(f"✅ Batch {current_batch_number} ({written_count}/{num_reviews_in_batch} reviews written) processed in {duration:.2f}s.")
                 total_processed_count += written_count
            else:
                 print(f"⚠️ No reviews written for Batch {current_batch_number} due to processing errors in AI response.")
                 error_count += 1


        # --- Specific API Error Handling ---
        except RateLimitError as e:
            wait_time = 30 # Default wait time
            print(f"🚦 Rate limit error on Batch {current_batch_number}. Waiting {wait_time}s... Error: {e}")
            error_count += 1
            time.sleep(wait_time)
            # Consider adding retry logic here if desired

        except BadRequestError as e:
            print(f"🚫 Bad request error on Batch {current_batch_number}. Check prompt size or content. Skipping batch. Error: {e}")
            print(f"   Review IDs in failed batch: {[m['review_id'] for m in batch_to_process]}")
            # Maybe log the prompt length: print(f"   Prompt length approx: {len(user_prompt)}")
            error_count += 1

        except APIError as e:
            print(f"💥 OpenAI API server error on Batch {current_batch_number}. Skipping batch. Error: {e}")
            error_count += 1
            # Consider adding retry logic here

        except APIConnectionError as e:
            print(f"🌐 API connection error on Batch {current_batch_number}. Check network? Skipping batch. Error: {e}")
            error_count += 1

        except AuthenticationError as e:
            print(f"🔑 Authentication error on Batch {current_batch_number}. Check API key? Stopping execution. Error: {e}")
            sys.exit(1) # Exit immediately if key is wrong

        # --- Catch-all for other unexpected errors ---
        except Exception as e:
            print(f"⚠️ An unexpected error occurred on Batch {current_batch_number}:")
            traceback.print_exc() # Print detailed traceback
            error_count += 1
            # Decide whether to stop or continue
            # print("Continuing to next batch despite error...")

        # --- Sleep between batches ---
        if start + args.batch_size < len(meta_rows): # Don't sleep after the last batch
             # print(f"Sleeping for {args.sleep}s...")
             time.sleep(args.sleep)

finally:
    # Ensure the output file is closed properly
    if 'output_file' in locals() and not output_file.closed:
        output_file.close()
        # print("\nOutput file closed.")

# --- Final Summary ---
print("\n" + "="*40)
print("🎉 Batch Processing Finished!")
print(f"   Total reviews initially loaded: {len(meta_rows)}")
print(f"   Total reviews successfully processed and written now: {total_processed_count}")
print(f"   Total reviews previously processed (if any): {len(processed_ids) - total_processed_count}")
print(f"   Total unique reviews in output file: {len(processed_ids)}")
print(f"   Number of batches encountered errors: {error_count}")
print(f"   Labeled data saved to: {args.output}")
print("="*40)