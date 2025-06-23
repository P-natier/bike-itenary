require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const allowedOrigins = ['https://delightful-treacle-d03c96.netlify.app'];

const corsOptions = {
  origin: function (origin, callback) {
    // The 'origin' is the URL of the site making the request (e.g., your Netlify app).
    // We check if this origin is in our list of allowed sites.
    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      // If it's in the list (or if there's no origin, like for server-to-server), allow it.
      callback(null, true);
    } else {
      // If it's not in the list, reject it with a CORS error.
      callback(new Error('Not allowed by CORS'));
    }
  }
};

app.use(cors(corsOptions));
app.use(express.json());

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GOOGLE_MAPS_API_BASE = 'https://maps.googleapis.com/maps/api';

// At the top of the file
const OpenAI = require('openai');
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // Add this to your .env file and Render
});

// A new function to get AI-improved waypoints

// --- Helper functions ---
function calculateDestinationPoint(lat, lng, bearing, distance) {
    const R = 6371;
    const d = distance;
    const lat1 = (lat * Math.PI) / 180;
    const lon1 = (lng * Math.PI) / 180;
    const brng = (bearing * Math.PI) / 180;
    let lat2 = Math.asin(Math.sin(lat1) * Math.cos(d / R) + Math.cos(lat1) * Math.sin(d / R) * Math.cos(brng));
    let lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d / R) * Math.cos(lat1), Math.cos(d / R) - Math.sin(lat1) * Math.sin(lat2));
    lat2 = (lat2 * 180) / Math.PI;
    lon2 = (lon2 * 180) / Math.PI;
    return { lat: lat2, lng: lon2 };
}

function getBearing(startPoint, endPoint) {
    const lat1 = (startPoint.lat * Math.PI) / 180;
    const lon1 = (startPoint.lng * Math.PI) / 180;
    const lat2 = (endPoint.lat * Math.PI) / 180;
    const lon2 = (endPoint.lng * Math.PI) / 180;
    const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
    const brng = Math.atan2(y, x);
    return ((brng * 180) / Math.PI + 360) % 360;
}

function normalizeTransportMode(mode) {
    // Convert frontend mode values to Google Maps API expected values
    const modeMap = {
        'BICYCLING': 'bicycling',
        'WALKING': 'walking',
        'bicycling': 'bicycling',
        'walking': 'walking'
    };
    return modeMap[mode] || 'bicycling'; // default to bicycling if unknown
}

// --- Main API Endpoint ---
app.post('/api/generate-loop', async (req, res) => {
    const { startLocation, targetDistance, mandatoryWaypoint, travelMode = 'bicycling' } = req.body;

    if (!startLocation || !targetDistance) {
        return res.status(400).json({ error: 'Missing startLocation or targetDistance' });
    }

    try {
        let result;
        if (mandatoryWaypoint) {
            console.log(`Generating loop with mandatory waypoint: "${mandatoryWaypoint}" for mode: ${travelMode}`);
            result = await generateLoopWithWaypoint(startLocation, targetDistance, mandatoryWaypoint, travelMode);
        } else {
            console.log(`Generating a random loop for mode: ${travelMode}`);
            result = await generateRandomLoop(startLocation, targetDistance, travelMode);
        }

        if (!result || !result.route) {
            throw new Error("Could not generate a valid route.");
        }
        
        let googleMapsUrl = 'https://www.google.com/maps/dir/';
        const origin = `${startLocation.lat},${startLocation.lng}`;
        const destination = origin;
        const waypointsString = result.waypointsUsed.map(wp => `${wp.lat},${wp.lng}`).join('/');
        
        const dirflg = travelMode.toLowerCase() === 'walking' ? 'w' : 'b';
        googleMapsUrl += `${origin}/${waypointsString}/${destination}?dirflg=${dirflg}`;

        res.json({
            polyline: result.route.overview_polyline.points,
            totalDistance: result.route.legs.reduce((total, leg) => total + leg.distance.value, 0),
            totalDuration: result.route.legs.reduce((total, leg) => total + leg.duration.value, 0),
            googleMapsUrl: googleMapsUrl
        });

    } catch (error) {
        console.error("Error in main handler:", error.message);
        res.status(500).json({ error: 'Failed to generate loop itinerary.', details: error.message });
    }
});


// --- Function to handle loops with a mandatory stop ---
async function generateLoopWithWaypoint(startLocation, targetDistance, mandatoryWaypointAddress, normalizedTravelMode) {
    const geoResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/geocode/json`, { params: { address: mandatoryWaypointAddress, key: API_KEY } });
    if (!geoResponse.data.results || geoResponse.data.results.length === 0) { throw new Error(`Could not find location for: "${mandatoryWaypointAddress}"`); }
    const mandatoryPoint = geoResponse.data.results[0].geometry.location;

    const directRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: `${mandatoryPoint.lat},${mandatoryPoint.lng}`, mode: normalizedTravelMode, key: API_KEY } });
    const directRoute = directRouteResponse.data.routes[0];
    const directDistance = directRoute.legs.reduce((sum, leg) => sum + leg.distance.value, 0);

    const targetDistanceMeters = targetDistance * 1000;
    const distanceDeficit = targetDistanceMeters - directDistance;

    if (distanceDeficit <= 500) {
        return { route: directRoute, waypointsUsed: [mandatoryPoint] };
    }
    
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
    
    const finalRouteResponse = await axios.get(`${GOOGLE_MAPS_API_BASE}/directions/json`, { params: { origin: `${startLocation.lat},${startLocation.lng}`, destination: `${startLocation.lat},${startLocation.lng}`, waypoints: finalWaypointsForRequest.join('|'), mode: normalizedTravelMode, key: API_KEY } });

    return { route: finalRouteResponse.data.routes[0], waypointsUsed: [theoreticalDetour1, mandatoryPoint, theoreticalDetour2] };
}

// --- Function for random loops ---
async function generateRandomLoop(startLocation, targetDistance, normalizedTravelMode) {
    const MAIN_ATTEMPTS = 10;
    const REFINE_ITERATIONS = 3;
    const ADJUSTMENT_FACTOR = 0.75;
    const targetDistanceMeters = targetDistance * 1000;
    let bestRoute = null;
    let minError = Infinity;
    let waypointsForBestRoute = [];

    for (let attempt = 0; attempt < MAIN_ATTEMPTS; attempt++) {
        const randomStartAngle = Math.random() * 360;
        const bearings = [(randomStartAngle), (randomStartAngle + 90) % 360, (randomStartAngle + 180) % 360];
        let legDistance = targetDistance / 4;

        for (let i = 0; i < REFINE_ITERATIONS; i++) {
            const waypoints = [];
            let currentPoint = startLocation;
            let canCreateWaypoints = true;
            for (const bearing of bearings) {
                const theoreticalPoint = calculateDestinationPoint(currentPoint.lat, currentPoint.lng, bearing, legDistance);
                try {
                    const snapResponse = await axios.get(`https://roads.googleapis.com/v1/snapToRoads`, { params: { path: `${theoreticalPoint.lat},${theoreticalPoint.lng}`, interpolate: false, key: API_KEY } });
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
                        mode: normalizedTravelMode, // Using normalized travel mode
                        key: API_KEY
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
        if (minError < 500 && bestRoute) { break; }
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
