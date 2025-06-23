let map;
let currentPolyline = null;
let geocoder;

// REDEFINE the initializeApp function that already exists in the HTML
// This is called by the Google Maps script when it's ready.
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
    });

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
    
    // Hide the Google Maps link at the start of a new generation
    if (gmapsLink) {
        gmapsLink.style.display = 'none';
    }

    generateBtn.disabled = true;

    // 2. Decide how to get the starting coordinates
    if (address.trim() !== "") {
        // User typed an address, so we need to geocode it
        statusDiv.textContent = `Finding "${address}"...`;
        geocodeAddress(address);
    } else {
        // User wants to use their current location
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
            // Once we have coordinates, call the backend
            callBackendForLoop(startLocation);
        } else {
            document.getElementById('status').textContent = `Could not find that address. Please try a different one. Reason: ${status}`;
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
                statusDiv.textContent = 'Generating your loop...';
                // Once we have coordinates, call the backend
                callBackendForLoop(startLocation);
            },
            () => {
                statusDiv.textContent = 'Geolocation failed. Please enable location services or enter an address.';
                generateBtn.disabled = false;
            }
        );
    } else {
        statusDiv.textContent = 'Geolocation is not supported by your browser. Please enter an address.';
        generateBtn.disabled = false;
    }
}

// This function sends all the user's choices to our backend server
async function callBackendForLoop(startLocation) {
    const targetDistance = document.getElementById('distance').value;
    const mandatoryWaypoint = document.getElementById('mandatory_waypoint').value;
    // Get the selected travel mode from the radio buttons
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
                travelMode: travelMode, // Send the new travel mode
            }),
            signal: controller.signal // Connect the timeout to the fetch request
        });
        
        // If we get a response, clear the timeout
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'The server returned an error.');
        }

        const data = await response.json();
        
        // Draw the route on the map
        drawRoute(data.polyline);
        
        // Update the status with the results
        const distanceInKm = (data.totalDistance / 1000).toFixed(2);
        const durationInMinutes = Math.round(data.totalDuration / 60);
        statusDiv.innerHTML = `Generated a <b>${distanceInKm} km</b> loop. <br> Estimated time: <b>${durationInMinutes} minutes</b>.`;
        
        // Display and update the "Open in Google Maps" link
        const gmapsLink = document.getElementById('gmaps-link');
        if (data.googleMapsUrl && gmapsLink) {
            gmapsLink.href = data.googleMapsUrl;
            gmapsLink.style.display = 'block';
        }

    } catch (error) {
        clearTimeout(timeoutId); // Also clear the timeout if an error occurs
        console.error('Error:', error);
        
        if (error.name === 'AbortError') {
            statusDiv.textContent = 'Error: The server took too long to respond. This can happen on the first try. Please try again.';
        } else {
            statusDiv.textContent = `Error: ${error.message}`;
        }
    } finally {
        // Re-enable the button so the user can try again
        generateBtn.disabled = false;
    }
}

// This function takes the encoded route path and draws it on the map
function drawRoute(encodedPolyline) {
    // Decode the polyline string into a path of coordinates
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

    // Adjust the map's zoom and center to fit the entire route
    const bounds = new google.maps.LatLngBounds();
    path.forEach(point => bounds.extend(point));
    map.fitBounds(bounds);
}
