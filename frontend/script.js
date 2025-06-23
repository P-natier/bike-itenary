// In frontend/script.js

let map;
let currentPolyline = null;
let geocoder;

// REDEFINE the initializeApp function that already exists in the HTML
initializeApp = async () => {
    const { Map } = await google.maps.importLibrary("maps");
    const { Geocoder } = await google.maps.importLibrary("geocoding");
    google.maps.importLibrary("geometry");

    const initialPosition = { lat: 48.8566, lng: 2.3522 }; // Paris
    map = new Map(document.getElementById("map"), {
        zoom: 12,
        center: initialPosition,
        mapTypeControl: false,
    });

    geocoder = new Geocoder();

    document.getElementById('generateBtn').addEventListener('click', generateLoop);
};

function generateLoop() {
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');
    const address = document.getElementById('address').value;
    const gmapsLink = document.getElementById('gmaps-link');

    if (currentPolyline) {
        currentPolyline.setMap(null);
    }
    
    // Hide the Google Maps link at the start of a new generation
    if (gmapsLink) {
        gmapsLink.style.display = 'none';
    }

    generateBtn.disabled = true;

    if (address.trim() !== "") {
        statusDiv.textContent = `Finding "${address}"...`;
        geocodeAddress(address);
    } else {
        statusDiv.textContent = 'Getting your current location...';
        useCurrentLocation();
    }
}

function geocodeAddress(address) {
    geocoder.geocode({ 'address': address }, (results, status) => {
        if (status === 'OK') {
            const startLocation = {
                lat: results[0].geometry.location.lat(),
                lng: results[0].geometry.location.lng()
            };
            map.setCenter(startLocation);
            document.getElementById('status').textContent = 'Generating your bike loop...';
            callBackendForLoop(startLocation);
        } else {
            document.getElementById('status').textContent = `Geocode was not successful for the following reason: ${status}. Please try a different address.`;
            document.getElementById('generateBtn').disabled = false;
        }
    });
}

function useCurrentLocation() {
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const startLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
                map.setCenter(startLocation);
                statusDiv.textContent = 'Generating your bike loop...';
                callBackendForLoop(startLocation);
            },
            () => {
                statusDiv.textContent = 'Geolocation failed. Please enable location services or enter an address.';
                generateBtn.disabled = false;
            }
        );
    } else {
        statusDiv.textContent = 'Geolocation is not supported. Please enter an address.';
        generateBtn.disabled = false;
    }
}

async function callBackendForLoop(startLocation) {
    const targetDistance = document.getElementById('distance').value;
    const mandatoryWaypoint = document.getElementById('mandatory_waypoint').value;
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');

    try {
        const response = await fetch('https://bike-loop-backend.onrender.com/api/generate-loop', { // Make sure this is your Render URL
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                startLocation,
                targetDistance: parseFloat(targetDistance),
                mandatoryWaypoint: mandatoryWaypoint.trim() === "" ? null : mandatoryWaypoint,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Backend request failed');
        }

        const data = await response.json();
        drawRoute(data.polyline);
        const distanceInKm = (data.totalDistance / 1000).toFixed(2);
        const durationInMinutes = Math.round(data.totalDuration / 60);
        statusDiv.innerHTML = `Generated a <b>${distanceInKm} km</b> loop. <br> Estimated time: <b>${durationInMinutes} minutes</b>.`;
        
        // Activate the Google Maps link
        const gmapsLink = document.getElementById('gmaps-link');
        if (data.googleMapsUrl && gmapsLink) {
            gmapsLink.href = data.googleMapsUrl;
            gmapsLink.style.display = 'block';
        }

    } catch (error) {
        console.error('Error:', error);
        statusDiv.textContent = `Error: ${error.message}`;
    } finally {
        generateBtn.disabled = false;
    }
}

function drawRoute(encodedPolyline) {
    const path = google.maps.geometry.encoding.decodePath(encodedPolyline);
    const routePolyline = new google.maps.Polyline({
        path: path,
        geodesic: true,
        strokeColor: '#FF0000',
        strokeOpacity: 0.8,
        strokeWeight: 5
    });
    routePolyline.setMap(map);
    currentPolyline = routePolyline;
    const bounds = new google.maps.LatLngBounds();
    path.forEach(point => bounds.extend(point));
    map.fitBounds(bounds);
}
