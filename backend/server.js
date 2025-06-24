console.log("--- Starting PathCycle Backend v3.5 (Mandatory Waypoint & AI Fix) ---");

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();

const allowedOrigins = ['https://delightful-treacle-d03c96.netlify.app'];
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

// --- AI Waypoint Improver Function (Updated) ---
async function getAiImprovedWaypoints(startLocation, initialWaypoints, targetDistance, travelMode, mandatoryPoint = null) {
    const waypointsText = JSON.stringify(initialWaypoints);
    let mandatoryPointInstruction = '';
    if (mandatoryPoint) {
        mandatoryPointInstruction = `CRITICAL: The route MUST pass through this mandatory waypoint: ${JSON.stringify(mandatoryPoint)}. Do not move or remove this waypoint from the final list. You can add or modify other waypoints around it.`;
    }
    const prompt = `
        You are an expert local route planner. Your task is to improve a route.
        The user wants a ${targetDistance} km loop for a ${travelMode} trip, starting and ending at ${JSON.stringify(startLocation)}.
        ${mandatoryPointInstruction}
        Here is a draft set of waypoints calculated by a geometric algorithm: ${waypointsText}.
        This draft already includes the mandatory waypoint if one was provided.
        Please refine the *other* waypoints to create a more enjoyable route. Prioritize bike lanes, greenways, and scenic paths. Avoid busy roads and simple out-and-back segments.
        You MUST respond ONLY with a valid JSON object in the following format, preserving the mandatory waypoint if it was given:
        {"waypoints": [{"lat": 45.123, "lng": 1.456}, ...]}
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
        } else { throw new Error("AI response was not in the expected format."); }
    } catch (error) {
        console.error("OpenAI call failed:", error.message);
        console.log("Falling back to original geometric waypoints.");
        return initialWaypoints;
    }
}

// --- Main API Endpoint (Updated) ---
app.post('/api/generate-loop', async (req, res) => {
    const { startLocation, targetDistance, mandatoryWaypointPlaceId, travelMode = 'BICYCLING', enhanceWithAI = false } = req.body;
    const normalizedTravelMode = travelMode.toLowerCase();

    if (!startLocation || !targetDistance) {
        return res.status(400).json({ error: 'Missing startLocation or targetDistance' });
    }

    try {
        let mandatoryPointCoords = null;
        if (mandatoryWaypointPlaceId) {
            console.log(`Fetching details for mandatory waypoint ID: ${mandatoryWaypointPlaceId}`);
            const detailsUrl = `https://places.googleapis.com/v1/places/${mandatoryWaypointPlaceId}`;
            const detailsResponse = await axios.get(detailsUrl, {
                params: { key: GOOGLE_MAPS_API_KEY, fields: 'location' }
            });
            if (detailsResponse.data && detailsResponse.data.location) {
                mandatoryPointCoords = {
                    lat: detailsResponse.data.location.latitude,
                    lng: detailsResponse.data.location.longitude
                };
            } else { throw new Error("Could not fetch details for mandatory waypoint."); }
        }

        let draftResult;
        if (mandatoryPointCoords) {
            draftResult = await generateLoopWithWaypoint(startLocation, targetDistance, mandatoryPointCoords, normalizedTravelMode);
        } else {
            draftResult = await generateRandomLoop(startLocation, targetDistance, normalizedTravelMode);
        }

        if (!draftResult || !draftResult.route) {
            throw new Error("Could not generate a valid initial route.");
        }
        
        let finalWaypoints = draftResult.waypointsUsed;
        if (enhanceWithAI) {
            finalWaypoints = await getAiImprovedWaypoints(startLocation, draftResult.waypointsUsed, targetDistance, normalizedTravelMode, mandatoryPointCoords);
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

// --- Autocomplete and Place Details Endpoints ---
app.post('/api/autocomplete', async (req, res) => {
    const { input } = req.body;
    if (!input) { return res.status(400).json({ error: 'Input text is required.' }); }
    const autocompleteUrl = 'https://places.googleapis.com/v1/places:autocomplete';
    const requestBody = {
        input: input,
        locationBias: { circle: { center: { latitude: 48.8566, longitude: 2.3522 }, radius: 50000.0 } }
    };
    try {
        const response = await axios.post(autocompleteUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
                'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text'
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error("Autocomplete API error:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        res.status(500).json({ error: 'Failed to fetch autocomplete suggestions.' });
    }
});
app.post('/api/placedetails', async (req, res) => {
    const { placeId } = req.body;
    if (!placeId) { return res.status(400).json({ error: 'Place ID is required.' }); }
    const detailsUrl = `https://places.googleapis.com/v1/places/${placeId}`;
    try {
        const response = await axios.get(detailsUrl, {
            params: { key: GOOGLE_MAPS_API_KEY, fields: 'location,formattedAddress' }
        });
        res.json(response.data);
    } catch (error) {
        console.error("Place Details API error:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        res.status(500).json({ error: 'Failed to fetch place details.' });
    }
});

// --- Function to handle loops with a mandatory stop (Updated) ---
async function generateLoopWithWaypoint(startLocation, targetDistance, mandatoryPoint, normalizedTravelMode) {
    const directRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: `${mandatoryPoint.lat},${mandatoryPoint.lng}`, mode: normalizedTravelMode, key: GOOGLE_MAPS_API_KEY } });
    const directRoute = directRouteResponse.data.routes[0];
    if (!directRoute) { throw new Error("Could not calculate a direct route to the mandatory waypoint."); }
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

// --- Function for random loops (Unchanged) ---
async function generateRandomLoop(startLocation, targetDistance, normalizedTravelMode) {
    const MAIN_ATTEMPTS = 25; const REFINE_ITERATIONS = 3; const ADJUSTMENT_FACTOR = 0.75;
    const targetDistanceMeters = targetDistance * 1000;
    let bestRoute = null; let minError = Infinity; let waypointsForBestRoute = [];
    for (let attempt = 0; attempt < MAIN_ATTEMPTS; attempt++) {
        let randomStartAngle;
        if (attempt < MAIN_ATTEMPTS - 4) { randomStartAngle = Math.random() * 360; }
        else { randomStartAngle = [0, 90, 180, 270][attempt - (MAIN_ATTEMPTS - 4)]; }
        const bearings = [(randomStartAngle), (randomStartAngle + 90) % 360, (randomStartAngle + 180) % 360];
        let legDistance = targetDistance / 4;
        for (let i = 0; i < REFINE_ITERATIONS; i++) {
            const waypoints = []; let currentPoint = startLocation; let canCreateWaypoints = true;
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
                const directionsResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: waypointsString, mode: normalizedTravelMode, key: GOOGLE_MAPS_API_KEY } });
                const route = directionsResponse.data.routes[0];
                if (route) {
                    const actualDistance = route.legs.reduce((total, leg) => total + leg.distance.value, 0);
                    const error = Math.abs(actualDistance - targetDistanceMeters);
                    if (error < minError) { minError = error; bestRoute = route; waypointsForBestRoute = waypoints; }
                    const errorRatio = targetDistanceMeters / actualDistance;
                    legDistance *= (1 - ADJUSTMENT_FACTOR) + (errorRatio * ADJUSTMENT_FACTOR);
                }
            } catch (dirError) { break; }
        }
        if (minError < 500 && bestRoute) { break; }
    }
    return { route: bestRoute, waypointsUsed: waypointsForBestRoute };
}

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
