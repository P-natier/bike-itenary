console.log("--- Starting PathCycle Backend v3.3 (Resilient Generator) ---");

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const OpenAI = require('openai');

// --- OpenAI Configuration ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const app = express();

// --- CORS Configuration ---
const allowedOrigins = ['https://delightful-treacle-d03c96.netlify.app']; // Your production frontend URL
const corsOptions = {
    origin: function (origin, callback) {
        if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error('This origin is not allowed by CORS'));
        }
    }
};
app.use(cors(corsOptions));
app.use(express.json());

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GOOGLE_MAPS_API_BASE = 'https://maps.googleapis.com/maps/api';

// --- Helper functions ---
function calculateDestinationPoint(lat, lng, bearing, distance) {
    const R = 6371; const d = distance;
    const lat1 = (lat * Math.PI) / 180; const lon1 = (lng * Math.PI) / 180;
    const brng = (bearing * Math.PI) / 180;
    let lat2 = Math.asin(Math.sin(lat1) * Math.cos(d / R) + Math.cos(lat1) * Math.sin(d / R) * Math.cos(brng));
    let lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d / R) * Math.cos(lat1), Math.cos(d / R) - Math.sin(lat1) * Math.sin(lat2));
    lat2 = (lat2 * 180) / Math.PI; lon2 = (lon2 * 180) / Math.PI;
    return { lat: lat2, lng: lon2 };
}
function getBearing(startPoint, endPoint) {
    const lat1 = (startPoint.lat * Math.PI) / 180; const lon1 = (startPoint.lng * Math.PI) / 180;
    const lat2 = (endPoint.lat * Math.PI) / 180; const lon2 = (endPoint.lng * Math.PI) / 180;
    const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
    const brng = Math.atan2(y, x);
    return ((brng * 180) / Math.PI + 360) % 360;
}

// --- AI Waypoint Improver Function ---
async function getAiImprovedWaypoints(startLocation, initialWaypoints, targetDistance, travelMode) {
    const waypointsText = JSON.stringify(initialWaypoints);
    const prompt = `
        You are an expert local route planner for cyclists and walkers.
        Your task is to improve a pre-calculated route by modifying its waypoints.
        The user wants a loop itinerary starting and ending at ${JSON.stringify(startLocation)}.
        The target distance is ${targetDistance} km for a ${travelMode} trip.
        Here is a draft set of waypoints calculated by a geometric algorithm: ${waypointsText}.

        Please refine these waypoints to create a more enjoyable route.
        Prioritize bike lanes for cycling, and pedestrian paths or parks for walking.
        Avoid busy roads, dead ends, and simple out-and-back segments if possible.
        Try to make the route more scenic or interesting.

        You MUST respond ONLY with a valid JSON object in the following format:
        {"waypoints": [{"lat": 45.123, "lng": 1.456}, ...]}
        The response should contain the same number of waypoints as the draft.
    `;
    try {
        console.log("Calling OpenAI to improve route...");
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ "role": "user", "content": prompt }],
            response_format: { "type": "json_object" },
        });
        const aiResponse = completion.choices[0].message.content;
        const parsedJson = JSON.parse(aiResponse);

        if (parsedJson && Array.isArray(parsedJson.waypoints) && parsedJson.waypoints.length > 0) {
            console.log("Successfully got improved waypoints from AI.");
            return parsedJson.waypoints;
        } else {
            throw new Error("AI response was not in the expected format.");
        }
    } catch (error) {
        console.error("OpenAI call failed:", error.message);
        console.log("Falling back to original geometric waypoints.");
        return initialWaypoints;
    }
}

// --- Main API Endpoint ---
app.post('/api/generate-loop', async (req, res) => {
    const { startLocation, targetDistance, mandatoryWaypoint, travelMode = 'BICYCLING', enhanceWithAI = false } = req.body;
    const normalizedTravelMode = travelMode.toLowerCase();

    if (!startLocation || !targetDistance) {
        return res.status(400).json({ error: 'Missing startLocation or targetDistance' });
    }

    try {
        let draftResult;
        if (mandatoryWaypoint) {
            draftResult = await generateLoopWithWaypoint(startLocation, targetDistance, mandatoryWaypoint, normalizedTravelMode);
        } else {
            draftResult = await generateRandomLoop(startLocation, targetDistance, normalizedTravelMode);
        }

        if (!draftResult || !draftResult.route) {
            throw new Error("Could not generate a valid initial route.");
        }
        
        let finalWaypoints = draftResult.waypointsUsed;
        if (enhanceWithAI) {
            finalWaypoints = await getAiImprovedWaypoints(startLocation, draftResult.waypointsUsed, targetDistance, normalizedTravelMode);
        }
        
        const finalWaypointsString = finalWaypoints.map(wp => `${wp.lat},${wp.lng}`).join('|');
        const finalDirectionsResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, {
            params: {
                origin: `${startLocation.lat},${startLocation.lng}`,
                destination: `${startLocation.lat},${startLocation.lng}`,
                waypoints: finalWaypointsString,
                mode: normalizedTravelMode,
                key: GOOGLE_MAPS_API_KEY
            }
        });
        const finalRoute = finalDirectionsResponse.data.routes[0];
        if (!finalRoute) { throw new Error("Could not route the final waypoints."); }

        const dirflg = normalizedTravelMode === 'walking' ? 'w' : 'b';
        const googleMapsUrl = `https://www.google.com/maps/dir/${startLocation.lat},${startLocation.lng}/${finalWaypoints.map(wp=>`${wp.lat},${wp.lng}`).join('/')}/${startLocation.lat},${startLocation.lng}?dirflg=${dirflg}`;

        res.json({
            polyline: finalRoute.overview_polyline.points,
            totalDistance: finalRoute.legs.reduce((total, leg) => total + leg.distance.value, 0),
            totalDuration: finalRoute.legs.reduce((total, leg) => total + leg.duration.value, 0),
            googleMapsUrl: googleMapsUrl
        });

    } catch (error) {
        console.error("Error in main handler:", error.message);
        res.status(500).json({ error: 'Failed to generate loop itinerary.', details: error.message });
    }
});

app.post('/api/autocomplete', async (req, res) => {
    const { input } = req.body;
    if (!input) { return res.status(400).json({ error: 'Input text is required.' }); }

    const autocompleteUrl = 'https://places.googleapis.com/v1/places:autocomplete';

    // --- THE FIX: Add a locationBias to make the request more specific ---
    const requestBody = {
        input: input,
        // Adding a location bias can help resolve 'INVALID_ARGUMENT' errors.
        // This example biases results towards Europe. You can adjust the coordinates.
        locationBias: {
            circle: {
                center: { latitude: 48.8566, longitude: 2.3522 }, // Paris
                radius: 1000000.0 // 1000 km radius
            }
        }
    };

    try {
        const response = await axios.post(
            autocompleteUrl,
            requestBody, // Use the new request body
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
                    'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text'
                }
            }
        );
        res.json(response.data);
    } catch (error) {
        // Log the full error from Google for better debugging
        console.error("Autocomplete API error:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        res.status(500).json({ error: 'Failed to fetch autocomplete suggestions.' });
    }
});

// --- NEW: Place Details API Endpoint ---
// We need this to get the coordinates from a place ID
app.post('/api/placedetails', async (req, res) => {
    const { placeId } = req.body;

    if (!placeId) {
        return res.status(400).json({ error: 'Place ID is required.' });
    }

    const detailsUrl = `https://places.googleapis.com/v1/places/${placeId}`;

    try {
        const response = await axios.get(detailsUrl, {
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
                // We need to tell it to look inside suggestions -> placePrediction
'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text'
            }
        });

        res.json(response.data);

    } catch (error) {
        console.error("Place Details API error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch place details.' });
    }
});


// --- Function to handle loops with a mandatory stop ---
async function generateLoopWithWaypoint(startLocation, targetDistance, mandatoryWaypointAddress, normalizedTravelMode) {
    const geoResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/geocode/json`, { params: { address: mandatoryWaypointAddress, key: GOOGLE_MAPS_API_KEY } });
    if (!geoResponse.data.results || geoResponse.data.results.length === 0) { throw new Error(`Could not find location for: "${mandatoryWaypointAddress}"`); }
    const mandatoryPoint = geoResponse.data.results[0].geometry.location;
    const directRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: `${mandatoryPoint.lat},${mandatoryPoint.lng}`, mode: normalizedTravelMode, key: GOOGLE_MAPS_API_KEY } });
    const directRoute = directRouteResponse.data.routes[0];
    const directDistance = directRoute.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
    const targetDistanceMeters = targetDistance * 1000;
    const distanceDeficit = targetDistanceMeters - directDistance;
    if (distanceDeficit <= 500) { return { route: directRoute, waypointsUsed: [mandatoryPoint] }; }
    const detourLegDistance = (distanceDeficit / 2) / 2;
    const bearingOut = getBearing(startLocation, mandatoryPoint);
    const detourBearingOut = (bearingOut + 90 * (Math.random() > 0.5 ? 1 : -1) + 360) % 360;
    const midpointOut = { lat: (startLocation.lat + mandatoryPoint.lat) / 2, lng: (startLocation.lng + mandatoryPoint.lng) / 2 };
    const theoreticalDetour1 = calculateDestinationPoint(midpointOut.lat, midpointOut.lng, detourBearingOut, detourLegDistance / 1000);
    const bearingIn = getBearing(mandatoryPoint, startLocation);
    const detourBearingIn = (bearingIn + 90 * (Math.random() > 0.5 ? 1 : -1) + 360) % 360;
    const midpointIn = { lat: (mandatoryPoint.lat + startLocation.lat) / 2, lng: (mandatoryPoint.lng + startLocation.lng) / 2 };
    const theoreticalDetour2 = calculateDestinationPoint(midpointIn.lat, midpointIn.lng, detourBearingIn, detourLegDistance / 1000);
    const finalWaypointsForRequest = [`${theoreticalDetour1.lat},${theoreticalDetour1.lng}`, `${mandatoryPoint.lat},${mandatoryPoint.lng}`, `${theoreticalDetour2.lat},${theoreticalDetour2.lng}`];
    const finalRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: finalWaypointsForRequest.join('|'), mode: normalizedTravelMode, key: GOOGLE_MAPS_API_KEY } });
    return { route: finalRouteResponse.data.routes[0], waypointsUsed: [theoreticalDetour1, mandatoryPoint, theoreticalDetour2] };
}

// --- UPDATED Function for random loops (More Resilient) ---
async function generateRandomLoop(startLocation, targetDistance, normalizedTravelMode) {
    const MAIN_ATTEMPTS = 25; // Increased attempts
    const REFINE_ITERATIONS = 3;
    const ADJUSTMENT_FACTOR = 0.75;
    const targetDistanceMeters = targetDistance * 1000;
    let bestRoute = null;
    let minError = Infinity;
    let waypointsForBestRoute = [];

    for (let attempt = 0; attempt < MAIN_ATTEMPTS; attempt++) {
        console.log(`--- Main Attempt #${attempt + 1}/${MAIN_ATTEMPTS} ---`);
        
        let randomStartAngle;
        if (attempt < MAIN_ATTEMPTS - 4) {
            randomStartAngle = Math.random() * 360; // Random direction
        } else {
            console.log("Random attempts failed, trying fixed direction as fallback...");
            randomStartAngle = [0, 90, 180, 270][attempt - (MAIN_ATTEMPTS - 4)]; // N, E, S, W
        }
        
        const bearings = [(randomStartAngle), (randomStartAngle + 90) % 360, (randomStartAngle + 180) % 360];
        let legDistance = targetDistance / 4;

        for (let i = 0; i < REFINE_ITERATIONS; i++) {
            const waypoints = [];
            let currentPoint = startLocation;
            let canCreateWaypoints = true;
            for (const bearing of bearings) {
                const theoreticalPoint = calculateDestinationPoint(currentPoint.lat, currentPoint.lng, bearing, legDistance);
                try {
                    const snapResponse = await axios.get(`https://roads.googleapis.com/v1/snapToRoads`, { params: { path: `${theoreticalPoint.lat},${theoreticalPoint.lng}`, interpolate: false, key: GOOGLE_MAPS_API_KEY } });
                    if (snapResponse.data.snappedPoints && snapResponse.data.snappedPoints.length > 0) {
                        const snappedPoint = snapResponse.data.snappedPoints[0].location;
                        waypoints.push({ lat: snappedPoint.latitude, lng: snappedPoint.longitude });
                        currentPoint = waypoints[waypoints.length - 1];
                    } else { throw new Error(`No snapped points`); }
                } catch (snapError) { canCreateWaypoints = false; break; }
            }
            if (!canCreateWaypoints) { break; }
            try {
                const waypointsString = waypoints.map(wp => `${wp.lat},${wp.lng}`).join('|');
                const directionsResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, {
                    params: {
                        origin: `${startLocation.lat},${startLocation.lng}`,
                        destination: `${startLocation.lat},${startLocation.lng}`,
                        waypoints: waypointsString,
                        mode: normalizedTravelMode,
                        key: GOOGLE_MAPS_API_KEY
                    }
                });
                const route = directionsResponse.data.routes[0];
                if (route) {
                    const actualDistance = route.legs.reduce((total, leg) => total + leg.distance.value, 0);
                    const error = Math.abs(actualDistance - targetDistanceMeters);
                    if (error < minError) {
                        minError = error;
                        bestRoute = route;
                        waypointsForBestRoute = waypoints;
                    }
                    const errorRatio = targetDistanceMeters / actualDistance;
                    legDistance *= (1 - ADJUSTMENT_FACTOR) + (errorRatio * ADJUSTMENT_FACTOR);
                }
            } catch (dirError) { break; }
        }
        if (minError < 500 && bestRoute) {
            console.log("Found a suitable route, breaking early.");
            break;
        }
    }
    return { 
        route: bestRoute,
        waypointsUsed: waypointsForBestRoute
    };
}

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
