let map;
let currentPolyline = null;
let geocoder;
// Global variables for the new UI elements
let mapLegend;
let startMarker = null;

// This function is called by the Google Maps script tag when it's ready.
// We redefine the empty function that was created in the HTML.
initializeApp = async () => {
    // Wait for the necessary Google Maps libraries to be fully loaded
    const { Map } = await google.maps.importLibrary("maps");
    const { Geocoder } = await google.maps.importLibrary("geocoding");
    google.maps.importLibrary("geometry"); // Needed for decoding the polyline

    // Create the map once libraries are ready
    const initialPosition = { lat: 48.8566, lng: 2.3522 }; // Default to Paris
    map = new Map(document.getElementById("map"), {
        zoom: 12,
        center: initialPosition,
        mapTypeControl: false,
        // Hide some default controls to make room for our custom legend
        fullscreenControl: false,
        streetViewControl: false,
        zoomControl: false,
    });

    // Create our custom legend div and add it to the map's controls
    mapLegend = document.createElement('div');
    mapLegend.id = 'map-legend';
    map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(mapLegend);

    // Initialize the geocoder service
    geocoder = new Geocoder();

    // Attach the main event listener to our button
    document.getElementById('generateBtn').addEventListener('click', generateLoop);
};

// This is the primary function triggered by the user
function generateLoop() {
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');
    const address = document.getElementById('address').value;
    const gmapsLink = document.getElementById('gmaps-link');

    // 1. Clean up the UI from any previous results
    if (currentPolyline) {
        currentPolyline.setMap(null);
    }
    if (startMarker) {
        startMarker.setMap(null);
    }
    if (mapLegend) {
        mapLegend.style.display = 'none';
    }
    
    if (gmapsLink) {
        gmapsLink.style.display = 'none';
    }

    generateBtn.disabled = true;

    // 2. Decide how to get the starting coordinates
    if (address.trim() !== "") {
        statusDiv.textContent = `Finding "${address}"...`;
        geocodeAddress(address);
    } else {
        statusDiv.textContent = 'Getting your current location...';
        useCurrentLocation();
    }
}

// Converts a text address into latitude/longitude
function geocodeAddress(address) {
    geocoder.geocode({ 'address': address }, (results, status) => {
        if (status === 'OK') {
            const startLocation = {
                lat: results[0].geometry.location.lat(),
                lng: results[0].geometry.location.lng()
            };
            map.setCenter(startLocation);
            document.getElementById('status').textContent = 'Generating your loop...';
            callBackendForLoop(startLocation);
        } else {
            document.getElementById('status').textContent = `Could not find that address. Reason: ${status}`;
            document.getElementById('generateBtn').disabled = false;
        }
    });
}

// Uses the browser's built-in geolocation service
function useCurrentLocation() {
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');

    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const startLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
                map.setCenter(startLocation);
                document.getElementById('status').textContent = 'Generating your loop...';
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

// This function sends all the user's choices to our backend server
async function callBackendForLoop(startLocation) {
    const targetDistance = document.getElementById('distance').value;
    const mandatoryWaypoint = document.getElementById('mandatory_waypoint').value;
    const travelMode = document.querySelector('input[name="travel-mode"]:checked').value;
    
    const statusDiv = document.getElementById('status');
    const generateBtn = document.getElementById('generateBtn');

    // Set up a 30-second timeout for the server request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch('https://bike-loop-backend.onrender.com/api/generate-loop', { // Your public Render backend URL
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                startLocation,
                targetDistance: parseFloat(targetDistance),
                mandatoryWaypoint: mandatoryWaypoint.trim() === "" ? null : mandatoryWaypoint,
                travelMode: travelMode,
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'The server returned an error.');
        }

        const data = await response.json();
        
        drawRoute(data.polyline);
        
        const distanceInKm = (data.totalDistance / 1000).toFixed(2);
        const durationInMinutes = Math.round(data.totalDuration / 60);
        statusDiv.innerHTML = `Generated a <b>${distanceInKm} km</b> loop. <br> Estimated time: <b>${durationInMinutes} minutes</b>.`;
        
        const gmapsLink = document.getElementById('gmaps-link');
        if (data.googleMapsUrl && gmapsLink) {
            gmapsLink.href = data.googleMapsUrl;
            gmapsLink.style.display = 'block';
        }

        // --- Update Legend and Add Marker ---
        const iconClass = travelMode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';

        mapLegend.innerHTML = `<i class="${iconClass}"></i> Loop: ${distanceInKm} km`;
        mapLegend.style.display = 'block';

        startMarker = new google.maps.Marker({
            position: startLocation,
            map: map,
            title: 'Start / Finish',
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 8,
                fillColor: "#FF0000",
                fillOpacity: 1,
                strokeWeight: 2,
                strokeColor: "#FFFFFF"
            }
        });
        
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('Error:', error);
        
        if (error.name === 'AbortError') {
            statusDiv.textContent = 'Error: The server took too long to respond. Please try again.';
        } else {
            statusDiv.textContent = `Error: ${error.message}`;
        }
    } finally {
        generateBtn.disabled = false;
    }
}

// This function takes the encoded route path and draws it on the map
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
    currentPolyline = routePolyline; // Save it so we can remove it later

    const bounds = new google.maps.LatLngBounds();
    path.forEach(point => bounds.extend(point));
    map.fitBounds(bounds);
}
