

// --- Required Modules ---
const fs = require('fs');   // For file system operations
const path = require('path'); // For handling file paths reliably

// --- Analysis Functions (Copied from previous examples) ---

/**
 * Analyzes an array of review data to aggregate insights.
 * @param {Array<Object>} reviewData - Array of review objects, each with an 'analysis' property.
 * @returns {Object} An object containing aggregated insights.
 */
function aggregateReviewInsights(reviewData) {
    const insights = {
        totalReviews: 0, // Start at 0, count valid ones
        themes: {}, // { themeName: { count: N, positive: N, negative: N, neutral: N, severitySum: N, severityCount: N, averageSeverity: 0 } }
        featureRequests: {
            count: 0,
            themes: {}, // { themeName: count }
            quotes: [] // Optionally store quotes for context
        },
        overallSentiment: { positive: 0, negative: 0, neutral: 0 },
        skippedReviews: 0 // Count reviews that couldn't be processed
    };

    if (!Array.isArray(reviewData)) {
         console.error("Input data is not an array. Cannot analyze.");
         insights.skippedReviews = reviewData === null ? 0 : 1; // Or estimate based on input type
         return insights;
    }

    insights.totalReviews = reviewData.length; // Total records attempted

    for (const review of reviewData) {
        // Skip if analysis data is missing or not an object
        if (!review || typeof review.analysis !== 'object' || review.analysis === null) {
            console.warn(`Skipping review ID ${review?.id || 'N/A'} due to missing or invalid 'analysis' object.`);
            insights.skippedReviews++;
            continue;
        }

        const analysis = review.analysis;
        const theme = analysis.theme || "Unknown Theme";
        const sentiment = analysis.sentiment || "neutral"; // Default to neutral if missing
        // Ensure severity is a number, default to 1 if missing or invalid type
        const severity = (typeof analysis.severity === 'number' && !isNaN(analysis.severity)) ? analysis.severity : 1;
        const isFeatureRequest = analysis.feature_request === 'Y';
        const quote = analysis.direct_quote || "";

        // --- Theme Aggregation ---
        if (!insights.themes[theme]) {
            insights.themes[theme] = { count: 0, positive: 0, negative: 0, neutral: 0, severitySum: 0, severityCount: 0, averageSeverity: 0 };
        }
        insights.themes[theme].count++;

        // --- Sentiment Aggregation ---
        if (sentiment === 'positive') {
            insights.themes[theme].positive++;
            insights.overallSentiment.positive++;
        } else if (sentiment === 'negative') {
            insights.themes[theme].negative++;
            insights.overallSentiment.negative++;
            // Track severity only for negative reviews
            insights.themes[theme].severitySum += severity;
            insights.themes[theme].severityCount++;
        } else { // neutral or unknown
            insights.themes[theme].neutral++;
            insights.overallSentiment.neutral++;
        }

        // --- Feature Request Aggregation ---
        if (isFeatureRequest) {
            insights.featureRequests.count++;
            insights.featureRequests.themes[theme] = (insights.featureRequests.themes[theme] || 0) + 1;
            // Optionally collect quotes for context (limit size if needed)
            if (insights.featureRequests.quotes.length < 50) { // Limit stored quotes
               insights.featureRequests.quotes.push({ theme, quote, review_id: analysis.review_id }); // Add review ID for reference
            }
        }
    }

    // Calculate average severity per theme
    for (const themeName in insights.themes) {
        const themeData = insights.themes[themeName];
        themeData.averageSeverity = themeData.severityCount > 0
            ? parseFloat((themeData.severitySum / themeData.severityCount).toFixed(2)) // Store as number
            : 0; // Avoid division by zero
    }

    return insights;
}

/**
 * Generates a SWOT analysis object based on aggregated review insights.
 * @param {Object} insights - The aggregated insights object from aggregateReviewInsights.
 * @returns {Object} An object containing SWOT analysis lists.
 */
function generateSWOTAnalysis(insights) {
    const swot = {
        strengths: [],
        weaknesses: [],
        opportunities: [],
        threats: []
    };

    const processedReviews = insights.totalReviews - insights.skippedReviews;
    if (processedReviews === 0) {
        console.warn("No valid reviews processed, cannot generate SWOT.");
        return swot;
    }

    // Define some thresholds (adjust based on your data volume and context)
    const POSITIVE_THRESHOLD = 0.65; // % positive sentiment within a theme to be a strength
    const NEGATIVE_THRESHOLD = 0.30; // % negative sentiment within a theme to be a weakness
    const HIGH_SEVERITY_THRESHOLD = 3.5; // Average severity >= this is a significant issue/threat
    const SIGNIFICANT_THEME_PERCENT = 0.05; // Theme must be >= 5% of processed reviews to be listed automatically

    // --- Analyze Themes for Strengths and Weaknesses ---
    for (const themeName in insights.themes) {
        const themeData = insights.themes[themeName];
        const themePercentage = themeData.count / processedReviews; // Base percentage on processed reviews

        if (themeData.count === 0) continue; // Skip empty themes

        const positiveRatio = themeData.positive / themeData.count;
        const negativeRatio = themeData.negative / themeData.count;

        // Potential Strength
        if (positiveRatio >= POSITIVE_THRESHOLD && themePercentage >= SIGNIFICANT_THEME_PERCENT) {
            swot.strengths.push(`High user satisfaction with '${themeName}' (${(positiveRatio * 100).toFixed(0)}% Positive of ${themeData.count} mentions).`);
        }

        // Potential Weakness
        if (negativeRatio >= NEGATIVE_THRESHOLD && themePercentage >= SIGNIFICANT_THEME_PERCENT) {
            swot.weaknesses.push(`Significant user dissatisfaction with '${themeName}' (${(negativeRatio * 100).toFixed(0)}% Negative of ${themeData.count} mentions, Avg Severity: ${themeData.averageSeverity.toFixed(2)}).`);
        }

        // Potential Threat (High Severity Weakness)
        // List as threat if it's a significant weakness AND severity is high
        if (negativeRatio >= NEGATIVE_THRESHOLD && themeData.averageSeverity >= HIGH_SEVERITY_THRESHOLD && themePercentage >= SIGNIFICANT_THEME_PERCENT) {
             swot.threats.push(`High severity issues reported for '${themeName}' (Avg Severity: ${themeData.averageSeverity.toFixed(2)}) could lead to user churn.`);
        }
    }

     // --- Analyze Overall Sentiment ---
     const overallPositiveRatio = insights.overallSentiment.positive / processedReviews;
     const overallNegativeRatio = insights.overallSentiment.negative / processedReviews;
     if (overallPositiveRatio > 0.6) { // Example threshold
         swot.strengths.push(`Generally positive sentiment across reviews (${(overallPositiveRatio * 100).toFixed(0)}% Positive of processed).`);
     }
     if (overallNegativeRatio > 0.3) { // Example threshold
         swot.weaknesses.push(`Notable overall negative sentiment across reviews (${(overallNegativeRatio * 100).toFixed(0)}% Negative of processed).`);
     }

    // --- Analyze Feature Requests for Opportunities ---
    if (insights.featureRequests.count > 0) {
        const frPercentage = (insights.featureRequests.count / processedReviews) * 100;
        swot.opportunities.push(`Active user suggestions for features (${insights.featureRequests.count} requests identified, ~${frPercentage.toFixed(1)}% of processed reviews).`);
        // List top themes for requests
        const sortedRequestThemes = Object.entries(insights.featureRequests.themes)
            .sort(([, countA], [, countB]) => countB - countA)
            .slice(0, 5); // Get top 5

        if (sortedRequestThemes.length > 0) {
             swot.opportunities.push(`Top themes associated with feature requests: ${sortedRequestThemes.map(([theme, count]) => `${theme} (${count})`).join(', ')}.`);
             // You could add logic here to pull specific quotes if needed
             // const sampleQuote = insights.featureRequests.quotes[0];
             // if (sampleQuote) {
             //    swot.opportunities.push(`Example request (ID ${sampleQuote.review_id}): "${sampleQuote.quote}"`);
             // }
        }
    } else {
        swot.opportunities.push("Limited explicit feature requests identified in this dataset.");
    }

     // --- Other potential Opportunities/Threats (Refinement) ---
     // Opportunity: Explicitly state that addressing weaknesses is an opportunity
     swot.weaknesses.forEach(weakness => {
         const themeMatch = weakness.match(/'([^']+)'/); // Extract theme name
         if (themeMatch && themeMatch[1]) {
            const theme = themeMatch[1];
            const severityMatch = weakness.match(/Avg Severity: (\d+(\.\d+)?)/);
            if (severityMatch && parseFloat(severityMatch[1]) >= HIGH_SEVERITY_THRESHOLD) {
                 swot.opportunities.push(`Opportunity to improve user retention by addressing high-severity issues in '${theme}'.`);
            } else {
                 swot.opportunities.push(`Opportunity to improve user satisfaction by addressing issues related to '${theme}'.`);
            }
         }
     });

    return swot;
}

/**
 * Loads JSON data synchronously from a file.
 * @param {string} filePath - The path to the JSON file.
 * @returns {Object|Array|null} The parsed JSON data, or null if an error occurs.
 */
function loadJsonFileSync(filePath) {
  try {
    const absolutePath = path.resolve(filePath); // Resolve to absolute path
    if (!fs.existsSync(absolutePath)) {
        console.error(`Error loading JSON file: File not found at "${absolutePath}"`);
        return null;
    }
    const fileContent = fs.readFileSync(absolutePath, 'utf8');
    const jsonData = JSON.parse(fileContent);
    console.log(`Successfully loaded JSON data from: ${absolutePath}`);
    return jsonData;
  } catch (error) {
    console.error(`Error loading or parsing JSON file "${filePath}":`);
    if (error instanceof SyntaxError) {
      console.error(" -> Invalid JSON format in the file:", error.message);
    } else {
      console.error(" -> ", error.message);
    }
    return null; // Indicate failure
  }
}


// --- Main Execution ---
function main() {
    // Get file path from command-line arguments
    const args = process.argv.slice(2); // Exclude 'node' and script name
    if (args.length === 0) {
        console.error("Usage: node run_analysis.js <path_to_json_file>");
        process.exit(1); // Exit with error code
    }
    const dataFilePath = args[0];

    // 1. Load the data
    console.log(`Attempting to load data from: ${dataFilePath}`);
    const appReviewData = loadJsonFileSync(dataFilePath);

    // Check if data loading failed
    if (appReviewData === null) {
        process.exit(1); // Exit if loading failed
    }

    const reviewData = appReviewData.analyses; // Assuming the data is in a 'data' property

    // Check if data is an array (basic validation)
     if (!Array.isArray(reviewData)) {
         console.error("Loaded data is not an array. Expected an array of review objects.");
         process.exit(1);
     }
     console.log(`Loaded ${reviewData.length} total records.`);


    // 2. Aggregate the insights
    console.log("\n--- Aggregating Insights ---");
    const aggregatedInsights = aggregateReviewInsights(reviewData);
    console.log(JSON.stringify(aggregatedInsights, null, 2)); // Pretty print the insights object

    if (aggregatedInsights.totalReviews === 0 || (aggregatedInsights.totalReviews - aggregatedInsights.skippedReviews === 0)) {
        console.log("\nNo valid reviews found or processed. Skipping SWOT analysis.");
        process.exit(0); // Exit cleanly
    }

    // 3. Generate the SWOT analysis from insights
    console.log("\n--- Generating SWOT Analysis ---");
    const swotAnalysis = generateSWOTAnalysis(aggregatedInsights);

    // 4. Print the SWOT Analysis
    console.log("\n--- SWOT Analysis (Derived from Review Data) ---");
    console.log(`Based on ${aggregatedInsights.totalReviews - aggregatedInsights.skippedReviews} processed reviews out of ${aggregatedInsights.totalReviews} total records.`);

    console.log("\n## Strengths:");
    if (swotAnalysis.strengths.length > 0) swotAnalysis.strengths.forEach(s => console.log(`  - ${s}`));
    else console.log("  (No significant strengths identified based on current thresholds)");

    console.log("\n## Weaknesses:");
    if (swotAnalysis.weaknesses.length > 0) swotAnalysis.weaknesses.forEach(w => console.log(`  - ${w}`));
    else console.log("  (No significant weaknesses identified based on current thresholds)");

    console.log("\n## Opportunities:");
     if (swotAnalysis.opportunities.length > 0) swotAnalysis.opportunities.forEach(o => console.log(`  - ${o}`));
    else console.log("  (No specific opportunities identified from requests or weaknesses)");

    console.log("\n## Threats:");
    if (swotAnalysis.threats.length > 0) swotAnalysis.threats.forEach(t => console.log(`  - ${t}`));
    else console.log("  (No significant threats identified based on high severity or other factors)");

    console.log("\n--- Analysis Complete ---");
}

// Run the main function
main();