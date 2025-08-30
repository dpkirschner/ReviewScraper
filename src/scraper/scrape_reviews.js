// Import the library
const store = require('app-store-scraper');
const path = require('path'); // Path module for joining paths
const fs = require('fs'); // File system module
const { createObjectCsvWriter } = require('csv-writer'); // CSV writing library

// --- Configuration ---
const COUNTRIES = ['us', 'cn', 'jp', 'gb', 'kr', 'de', 'fr', 'ca', 'au', 'it', 'es', 'br', 'ru', 'in', 'mx'];
const NUM_PAGES = 10;
const SORT_METHODS = [store.sort.RECENT, store.sort.HELPFUL];
const THROTTLE_MS = 500;

// Helper function to sanitize app title for use in filename
function sanitizeFilename(name) {
    // Remove or replace characters invalid in filenames across common OS
    // (e.g., / \ : * ? " < > |) and trim whitespace
    return name.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_').trim() || 'app';
}

// --- Function to process reviews for a single country ---
// Returns an array of review objects, each augmented with the country code.
async function fetchReviewsForCountry(appId, countryCode, numPages, sortByMethod) {
    const sortMethodName = Object.keys(store.sort).find(key => store.sort[key] === sortByMethod);
    console.log(`Starting review scraping for App ID ${appId} in ${countryCode.toUpperCase()} (Sort: ${sortMethodName}):`);
    console.log(`  Pages:   ${numPages}`);
    console.log('---');

    let allReviews = [];
    const pagesToFetch = Math.min(numPages, 10); // API limit

    for (let pageNum = 1; pageNum <= pagesToFetch; pageNum++) {
        console.log(`Fetching page ${pageNum}...`);
        try {
            // Fetch reviews for the current page
            const reviews = await store.reviews({
                id: appId,
                country: countryCode,
                page: pageNum,
                sort: sortByMethod,
                throttle: THROTTLE_MS
            });

            console.log(`  Fetched ${reviews.length} reviews from page ${pageNum}.`);

            if (reviews.length === 0) {
                console.log('  No more reviews found on this page, stopping.');
                break; // Stop if a page returns no reviews (likely reached the end)
            }

            // Add country code to each review before adding to the list
            const reviewsWithCountry = reviews.map(review => ({
                ...review,
                country: countryCode.toUpperCase() // Add country field
            }));
            allReviews = allReviews.concat(reviewsWithCountry);

        } catch (error) {
            console.error(`ERROR fetching page ${pageNum}:`, error.message || error);
            break; // Stop on error to avoid infinite loop
        }
    }

    console.log('---');
    console.log(`Total reviews fetched for ${countryCode.toUpperCase()} (Sort: ${sortMethodName}): ${allReviews.length}`);

    return allReviews; // Return the fetched reviews
}

// --- Main Execution Function ---
async function fetchReviewsForAllCountries(app_id) {
    console.log(`Starting review scraping process for App ID: ${app_id}`);
    console.log(`Target Countries: ${COUNTRIES.join(', ').toUpperCase()}`);
    console.log(`Max Pages per Country: ${NUM_PAGES} (API limited to 10)`);
    console.log(`Sort Orders: ${SORT_METHODS.map(method => Object.keys(store.sort).find(key => store.sort[key] === method)).join(', ')}`);
    console.log('==================================================');

    // Fetch app title once using the first country (or a default like 'us')
    let appTitle = 'UnknownApp';
    const primaryCountry = COUNTRIES[0] || 'us'; // Use first country or default to US
    try {
        console.log(`Fetching app data for title using country ${primaryCountry.toUpperCase()}...`);
        const appData = await store.app({ id: app_id, country: primaryCountry });
        appTitle = appData.title;
        console.log(`  Using App Title: ${appTitle}`);
    } catch (error) {
        console.warn(`WARN: Could not fetch app data for title. Using default filename. Error: ${error.message || error}`);
    }
    console.log('--------------------------------------------------');

    // Use a Map to store reviews, keyed by review ID for automatic deduplication
    const allReviewsMap = new Map();

    for (const sortMethod of SORT_METHODS) {
        const sortMethodName = Object.keys(store.sort).find(key => store.sort[key] === sortMethod);
        console.log(`\n===== Processing Sort Method: ${sortMethodName} =====`);
        for (const country of COUNTRIES) {
            console.log(`\n--- Processing Country: ${country.toUpperCase()} (Sort: ${sortMethodName}) ---`);
            try {
                const countryReviews = await fetchReviewsForCountry(app_id, country, NUM_PAGES, sortMethod, THROTTLE_MS);
                // Add reviews to the map, overwriting duplicates (ensures uniqueness across sort methods)
                countryReviews.forEach(review => allReviewsMap.set(review.id, review));
                console.log(`--- Finished processing ${country.toUpperCase()} (Sort: ${sortMethodName}). Found ${countryReviews.length} reviews (Total unique: ${allReviewsMap.size}) ---`);
            } catch (error) {
                console.error(`\n!!! CRITICAL ERROR processing country ${country.toUpperCase()} (Sort: ${sortMethodName}):`, error.message || error);
                console.error('!!! Skipping to the next country for this sort method.');
            }
            console.log('--------------------------------------------------');
        }
        console.log('--------------------------------------------------');
    }

    // Convert map values (unique reviews) to an array
    const finalReviews = Array.from(allReviewsMap.values());

    console.log('\n==================================================');
    console.log(`Finished processing all countries.`);
    console.log(`Total unique reviews collected: ${finalReviews.length}`);

    // --- Save Combined & Deduplicated Reviews to CSV ---
    if (finalReviews.length > 0) {
        const safeAppTitle = sanitizeFilename(appTitle);
        const csvFilename = `${safeAppTitle}_ALL_SORTED_reviews.csv`; // Indicate multiple sorts used
        const csvPath = path.join(__dirname, csvFilename); // Save in the script's directory

        console.log(`\nAttempting to save ${finalReviews.length} unique reviews to: ${csvPath}`);

        const csvWriter = createObjectCsvWriter({
            path: csvPath,
            header: [
                { id: 'id', title: 'Review ID' },
                { id: 'country', title: 'Country' }, // Added Country column
                { id: 'userName', title: 'User Name' },
                { id: 'userUrl', title: 'User URL' },
                { id: 'version', title: 'App Version' },
                { id: 'score', title: 'Rating' },
                { id: 'title', title: 'Review Title' },
                { id: 'text', title: 'Review Text' },
                { id: 'url', title: 'Review URL' },
                { id: 'date', title: 'Review Date' },
                { id: 'replyDate', title: 'Developer Reply Date' },
                { id: 'replyText', title: 'Developer Reply Text' },
                { id: 'helpfulVotes', title: 'Helpful Votes' }
            ]
        });

        try {
            await csvWriter.writeRecords(finalReviews);
            console.log(`Successfully saved ${finalReviews.length} unique reviews to ${csvPath}`);
        } catch (error) {
            console.error(`ERROR writing combined CSV file (${csvPath}):`, error.message || error);
        }
    } else {
        console.log("\nNo reviews were collected across all countries.");
    }

    console.log('\nScript finished.');
}

// Find these on the app's App Store page URL
// Example URL (Instagram): https://apps.apple.com/us/app/instagram/id389801252
const APP_IDS = ['737534985','991473495', '1154059529', '349866256'];
for (const APP_ID of APP_IDS) {
    fetchReviewsForAllCountries(APP_ID);
}