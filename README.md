Okay, here is a consolidated `README.md` file describing the complete project (scraping + analysis) as a functional Node.js application.

```markdown
# App Store Review Scraper & LLM Analyzer

## 🚀 Overview

This project provides a comprehensive Node.js toolkit for gathering and analyzing mobile app reviews from the Apple App Store. It consists of two core components:

1.  **Review Scraper:** Efficiently fetches app reviews across multiple countries and sorting methods directly from the App Store.
2.  **Review Analyzer:** Leverages Large Language Models (LLMs) via the OpenAI API to automatically categorize and extract insights from the scraped reviews based on a custom-defined taxonomy.

Together, these tools enable the transformation of raw, unstructured user feedback into actionable, quantitative data for product analysis, market research, and monitoring app health.

## ✨ Features

### Review Scraper (`scrape-reviews.js` - conceptual name)

*   **Multi-App Support:** Scrapes reviews for one or more App IDs provided as input.
*   **Multi-Country Fetching:** Gathers reviews from a configurable list of App Store country codes (e.g., 'us', 'gb', 'jp').
*   **Multiple Sort Orders:** Fetches reviews using different sort criteria (e.g., Most Recent, Most Helpful) to capture a broader range of feedback.
*   **Pagination Handling:** Automatically iterates through available review pages for each country/sort combination (respecting API limits, typically up to 10 pages per query).
*   **Deduplication:** Ensures unique reviews are collected, even if they appear across different sort orders or country requests, by using the review ID.
*   **Metadata Enrichment:** Adds the source country code to each review record.
*   **Dynamic Filenames:** Automatically fetches the app title to generate descriptive output filenames (e.g., `AppName_reviews.csv`). Includes filename sanitization for cross-OS compatibility.
*   **Configurable Throttling:** Includes delays between requests to avoid hitting API rate limits.
*   **Robust Error Handling:** Manages potential errors during network requests or data fetching for specific countries.
*   **Structured CSV Output:** Saves all unique, scraped reviews into a clean CSV file, including metadata like review ID, country, rating, version, text, date, etc.

### Review Analyzer (`analyze-reviews.js` - conceptual name)

*   **CSV Review Ingestion:** Reads app reviews from a standard CSV file format (typically the output of the scraper component).
*   **Custom Taxonomy Integration:** Uses a user-provided JSON file to define specific categories (themes) relevant to the app or analysis.
*   **LLM-Powered Categorization:** Leverages an LLM (via OpenAI API) to analyze each review and assign:
    *   **Primary Theme:** The main topic discussed, based on the provided taxonomy.
    *   **Sentiment:** Positive, neutral, or negative feeling expressed.
    *   **Severity:** A numerical score indicating the intensity of the feedback (especially for negative sentiment).
    *   **Feature Request:** Identifies if the review suggests a new feature or improvement ('Y'/'N').
*   **Direct Quote Extraction:** Pulls a concise, representative quote from the review text related to the identified theme.
*   **Batch Processing:** Sends reviews to the LLM API in batches for efficiency and cost/rate limit management.
*   **Configurable Parameters:** Allows customization via command-line arguments (input/output files, column names, LLM model, batch size, timeout, throttling delay).
*   **API Key Management:** Securely reads the OpenAI API key from environment variables (e.g., `OPENAI_API_KEY` loaded via `.env`).
*   **Resumable Processing:** Checks the output file for already processed review IDs and skips them, allowing the script to resume after interruptions.
*   **Robust API Error Handling:** Includes specific handling for common OpenAI API errors (rate limits, connection issues, authentication, bad requests).
*   **Structured CSV Output:** Generates a new CSV file containing the original review data enriched with the LLM-generated labels (`theme`, `sentiment`, `severity`, `feature_request`, `direct_quote`).

## ⚙️ Workflow

The typical workflow involves running the two components sequentially:

1.  **Scrape Reviews:**
    *   Configure the scraper with the target App ID(s), desired countries, and sort methods.
    *   Run the scraper script (`scrape-reviews.js`).
    *   The script fetches reviews page by page for each country/sort combination, deduplicates them, and saves the combined results to an intermediate CSV file (e.g., `AppName_ALL_SORTED_reviews.csv`).
2.  **Analyze Reviews:**
    *   Prepare a `taxonomy.json` file defining the analysis categories.
    *   Configure the analyzer with the path to the scraped reviews CSV, the taxonomy file, desired output path, and OpenAI API settings (model, key).
    *   Run the analyzer script (`analyze-reviews.js`).
    *   The script reads the scraped reviews, batches them, sends them to the OpenAI API with the taxonomy context, parses the responses, and appends the labeled data (original review + LLM insights) to the final output CSV (e.g., `AppName_labeled_reviews.csv`).

## 🛠️ Usage / Configuration

Both scripts are configured via command-line arguments and environment variables.

### Environment Variables

*   `OPENAI_API_KEY`: **Required** for the analyzer script. Your secret key for accessing the OpenAI API. Can be set directly or placed in a `.env` file in the project root.

### Scraper Script (`scrape-reviews.js`)

*(Example command - specific arguments may vary)*

```bash
node scrape-reviews.js --appIds 123456789,987654321 --countries us,gb,jp --pages 10 --sort recent,helpful --outputDir ./scraped_data
```

*   `--appIds`: Comma-separated list of App Store IDs.
*   `--countries`: Comma-separated list of two-letter country codes.
*   `--pages`: Maximum number of pages to fetch per country/sort combination (API limit is 10).
*   `--sort`: Comma-separated list of sort methods (e.g., `recent`, `helpful`).
*   `--outputDir`: Directory where scraped CSV files will be saved.
*   *(Other potential options: `--throttleMs`)*

### Analyzer Script (`analyze-reviews.js`)

*(Example command - specific arguments may vary)*

```bash
node analyze-reviews.js \
    --reviews ./scraped_data/AppName_ALL_SORTED_reviews.csv \
    --reviewTextCol "Review Text" \
    --reviewIdCol "Review ID" \
    --taxonomy ./config/taxonomy.json \
    --output ./labeled_data/AppName_labeled_reviews.csv \
    --model gpt-4.1-mini \
    --batchSize 20 \
    --sleep 2 \
    --timeout 120
```

*   `--reviews`: Path to the input CSV file generated by the scraper.
*   `--reviewTextCol`: Column name containing the review text in the input CSV.
*   `--reviewIdCol`: Column name containing the unique review identifier.
*   `--taxonomy`: Path to the taxonomy JSON file.
*   `--output`: Path for the final CSV file with labels.
*   `--model`: OpenAI model identifier to use for analysis.
*   `--batchSize`: Number of reviews to process per API call.
*   `--sleep`: Seconds to pause between API batch calls.
*   `--timeout`: Timeout in seconds for individual API calls.

## 📁 Inputs & Outputs

### Inputs

1.  **App ID(s):** Provided to the scraper script.
2.  **Taxonomy File (`taxonomy.json`):** A JSON file defining analysis categories for the analyzer script. Structure example:
    ```json
    [
      { "name": "Bug Report", "description": "User is reporting a technical issue..." },
      { "name": "Feature Request", "description": "User is suggesting a new feature..." },
      // ... other themes
      { "name": "General Feedback", "description": "Generic comment..." }
    ]
    ```

### Intermediate Output (from Scraper)

*   **Scraped Reviews CSV:** (e.g., `AppName_ALL_SORTED_reviews.csv`) Contains raw, deduplicated reviews with columns like:
    *   `Review ID`
    *   `Country`
    *   `User Name`
    *   `App Version`
    *   `Rating`
    *   `Review Title`
    *   `Review Text`
    *   `Review Date`
    *   `Helpful Votes`
    *   *(Potentially others like `User URL`, `Review URL`, `Developer Reply Text/Date`)*

### Final Output (from Analyzer)

*   **Labeled Reviews CSV:** (e.g., `AppName_labeled_reviews.csv`) Contains all columns from the intermediate CSV, plus the LLM-generated columns:
    *   `theme`
    *   `sentiment`
    *   `severity`
    *   `feature_request`
    *   `direct_quote`

## 🔧 Setup & Dependencies

1.  **Node.js:** Ensure Node.js (v16 or higher recommended) and npm are installed.
2.  **Clone Repository:** `git clone <repository-url>`
3.  **Install Dependencies:** `cd <repository-directory>` and run `npm install`. This will install libraries such as:
    *   `app-store-scraper` (for scraping)
    *   `csv-writer`, `csv-parser` (for CSV handling)
    *   `openai` (for OpenAI API interaction)
    *   `dotenv` (for environment variable loading)
    *   `yargs` (for command-line argument parsing)
    *   *(Potentially others)*
4.  **API Key:** Create a `.env` file in the project root and add your OpenAI API key:
    ```
    OPENAI_API_KEY=sk-YourSecretKeyHere
    ```
5.  **Taxonomy:** Create your `taxonomy.json` file (e.g., in a `config` directory).

You are now ready to run the scraping and analysis scripts as described in the Usage section.
```