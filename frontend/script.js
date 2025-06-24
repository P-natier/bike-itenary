document.addEventListener('DOMContentLoaded', () => {

    // --- Global variables, scoped to our DOM-ready function ---
    let map;
    let currentPolyline = null;
    let geocoder;
    let mapLegend;
    let startMarker = null;

    // NEW: Store the validated place data from the new Autocomplete
    let startLocationData = null;       // Will hold { placeId: '...', displayName: '...' }
    let mandatoryWaypointData = null;  // Will hold { placeId: '...', displayName: '...' }

    // --- We make initializeApp a global function by attaching it to the 'window' object ---
    window.initializeApp = async () => {
        // Import Google Maps libraries
        const { Map } = await google.maps.importLibrary("maps");
        const { Geocoder } = await google.maps.importLibrary("geocoding");
        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        google.maps.importLibrary("geometry");

        let initialPosition = { lat: 48.8566, lng: 2.3522 }; // Default to Paris
        try {
            const history = JSON.parse(localStorage.getItem('loopHistory') || '[]');
            if (history.length > 0 && history[0].startLocation) {
                initialPosition = history[0].startLocation;
            }
        } catch (e) { console.error("Could not parse history for initial position:", e); }
        
        map = new Map(document.getElementById("map"), {
            zoom: 12,
            center: initialPosition,
            mapTypeControl: false,
            fullscreenControl: false,
            streetViewControl: false,
            zoomControl: false,
            mapId: 'BIKE_LOOP_GENERATOR_MAP'
        });

        geocoder = new Geocoder();
        
        // Safely attach event listeners now that the DOM is ready
        mapLegend = document.getElementById('map-legend');
        document.getElementById('generateBtn').addEventListener('click', generateLoop);
        document.getElementById("logo-toggle-button").addEventListener("click", () => {
            document.getElementById("controls").classList.toggle("open");
        });

        // --- NEW: Setup the new Autocomplete (New) logic for both inputs ---
        setupAutocomplete('address', 'start-suggestions', (place) => {
            startLocationData = place; // Store selected place
        });
        setupAutocomplete('mandatory_waypoint', 'waypoint-suggestions', (place) => {
            mandatoryWaypointData = place; // Store selected place
        });

        loadHistory();
    };

    // --- NEW Autocomplete (New) Helper Function ---
    function setupAutocomplete(inputId, suggestionsId, onPlaceSelected) {
        const input = document.getElementById(inputId);
        const suggestionsContainer = document.getElementById(suggestionsId);
        let debounceTimer;

        input.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            const query = e.target.value;

            if (query.length < 3) {
                suggestionsContainer.innerHTML = '';
                suggestionsContainer.style.display = 'none';
                onPlaceSelected(null); // Clear stored data if input is cleared
                return;
            }

            // Debounce the API call to avoid spamming on every keystroke
            debounceTimer = setTimeout(async () => {
                try {
                    const response = await fetch('https://bike-loop-backend.onrender.com/api/autocomplete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ input: query })
                    });
                    if (!response.ok) throw new Error('Autocomplete fetch failed');
                    
                    const data = await response.json();

                    suggestionsContainer.innerHTML = '';
                    if (data && data.suggestions) {
                        suggestionsContainer.style.display = 'block';
                        data.suggestions.forEach(({ placePrediction }) => {
                            const item = document.createElement('div');
                            item.className = 'suggestion-item';
                            item.textContent = placePrediction.text.text;
                            item.addEventListener('click', () => {
                                input.value = placePrediction.text.text;
                                suggestionsContainer.innerHTML = '';
                                suggestionsContainer.style.display = 'none';
                                onPlaceSelected({
                                    placeId: placePrediction.placeId,
                                    displayName: placePrediction.text.text
                                });
                            });
                            suggestionsContainer.appendChild(item);
                        });
                    } else {
                        suggestionsContainer.style.display = 'none';
                    }
                } catch (error) {
                    console.error("Autocomplete error:", error);
                    suggestionsContainer.style.display = 'none';
                }
            }, 300); // Wait 300ms after user stops typing
        });

        // Hide suggestions when clicking outside
        document.addEventListener('click', (e) => {
            if (!input.contains(e.target)) {
                suggestionsContainer.style.display = 'none';
            }
        });
    }


    // --- All other functions live inside the DOMContentLoaded listener ---

    function clearUI() {
        if (currentPolyline) currentPolyline.setMap(null);
        if (startMarker) startMarker.map = null;
        startMarker = null;
        if (mapLegend) mapLegend.style.display = 'none';
        const gmapsLink = document.getElementById('gmaps-link');
        if (gmapsLink) gmapsLink.style.display = 'none';
        document.getElementById('status').textContent = 'Enter a starting point and distance, then click Generate.';
    }

 // --- UPDATED generateLoop function ---
    async function generateLoop() {
        clearUI();
        const generateBtn = document.getElementById('generateBtn');
        const addressInput = document.getElementById('address');
        generateBtn.disabled = true;

        let startLocation;

        if (startLocationData && startLocationData.placeId) {
            // A place was selected, get its details from our backend
            document.getElementById('status').textContent = 'Getting location details...';
            try {
                const response = await fetch('https://bike-loop-backend.onrender.com/api/placedetails', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ placeId: startLocationData.placeId })
                });
                if (!response.ok) throw new Error('Place details fetch failed');
                
                const placeDetails = await response.json();
                
                if (placeDetails.location) {
                    startLocation = { lat: placeDetails.location.latitude, lng: placeDetails.location.longitude };
                    map.setCenter(startLocation);
                    document.getElementById('status').textContent = 'Generating your loop...';
                    callBackendForLoop(startLocation);
                } else {
                    throw new Error('Invalid location data received.');
                }
            } catch(error) {
                document.getElementById('status').textContent = `Error: ${error.message}`;
                generateBtn.disabled = false;
            }
        } else if (addressInput.value.trim() !== '') {
            // Fallback to legacy geocoding if text is present but no place was selected
            document.getElementById('status').textContent = `Finding "${addressInput.value}"...`;
            geocodeAddress(addressInput.value);
        } else {
            // Fallback to geolocation if input is empty
            document.getElementById('status').textContent = 'Getting your current location...';
            useCurrentLocation();
        }
    }

    function geocodeAddress(address) {
        geocoder.geocode({ 'address': address }, (results, status) => {
            if (status === 'OK') {
                const startLocation = { lat: results[0].geometry.location.lat(), lng: results[0].geometry.location.lng() };
                map.setCenter(startLocation);
                document.getElementById('status').textContent = 'Generating your loop...';
                callBackendForLoop(startLocation);
            } else {
                document.getElementById('status').textContent = `Could not find that address. Reason: ${status}`;
                document.getElementById('generateBtn').disabled = false;
            }
        });
    }

    function useCurrentLocation() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const startLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
                    map.setCenter(startLocation);
                    document.getElementById('status').textContent = 'Generating your loop...';
                    callBackendForLoop(startLocation);
                },
                () => {
                    document.getElementById('status').textContent = 'Geolocation failed. Please enable location services or enter an address.';
                    document.getElementById('generateBtn').disabled = false;
                }
            );
        } else {
            document.getElementById('status').textContent = 'Geolocation is not supported. Please enter an address.';
            document.getElementById('generateBtn').disabled = false;
        }
    }

    async function callBackendForLoop(startLocation) {
        const targetDistance = document.getElementById('distance').value;
        const enhanceWithAI = document.getElementById('ai-toggle').checked;
        const travelMode = document.querySelector('input[name="travel-mode"]:checked').value;
        
        // UPDATED: Use the validated place's ID for the mandatory waypoint
        const mandatoryWaypointPlaceId = mandatoryWaypointData ? mandatoryWaypointData.placeId : null;
        
        const generateBtn = document.getElementById('generateBtn');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        try {
            const response = await fetch('https://bike-loop-backend.onrender.com/api/generate-loop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    startLocation,
                    targetDistance: parseFloat(targetDistance),
                    mandatoryWaypointPlaceId: mandatoryWaypointPlaceId,
                    travelMode,
                    enhanceWithAI,
                }),
                signal: controller.signal
        });

            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || "Server responded with an error.");
            }

            const data = await response.json();
            
            const addressText = document.getElementById('address').value.trim();
            const historyEntry = {
                address: addressText || 'Current Location',
                startLocation: startLocation,
                distance: targetDistance,
                mode: travelMode,
                polyline: data.polyline,
                totalDistance: data.totalDistance,
                totalDuration: data.totalDuration,
                googleMapsUrl: data.googleMapsUrl
            };
            
            displayRouteFromHistory(historyEntry);
            saveToHistory(historyEntry);
            
        } catch (error) {
            clearTimeout(timeoutId);
            document.getElementById('status').textContent = `Error: ${error.message}`;
        } finally {
            generateBtn.disabled = false;
        }
    }

    async function displayRouteFromHistory(historyItem) {
        clearUI();

        const routeColor = historyItem.mode === 'WALKING' ? '#0000FF' : '#FF0000';
        const distanceInKm = (historyItem.totalDistance / 1000).toFixed(2);
        const durationInMinutes = Math.round(historyItem.totalDuration / 60);

        drawRoute(historyItem.polyline, routeColor);
        
        document.getElementById('status').innerHTML = `Displaying route from history.<br><b>${distanceInKm} km</b> loop, approx. <b>${durationInMinutes} minutes</b>.`;

        const gmapsLink = document.getElementById('gmaps-link');
        if (historyItem.googleMapsUrl) {
            gmapsLink.href = historyItem.googleMapsUrl;
            gmapsLink.style.display = 'block';
        }

        if (mapLegend) {
            const iconClassLegend = historyItem.mode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
            mapLegend.innerHTML = `<i class="${iconClassLegend}" style="color: ${routeColor};"></i> Loop: ${distanceInKm} km`;
            mapLegend.style.display = 'flex';
        }

        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        const iconClassMarker = historyItem.mode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
        const markerIcon = document.createElement('i');
        markerIcon.className = `${iconClassMarker} fa-2x fa-map-marker`;
        markerIcon.style.color = routeColor;

        startMarker = new AdvancedMarkerElement({
            map: map,
            position: historyItem.startLocation,
            title: 'Start / Finish',
            content: markerIcon,
        });
    }

    function drawRoute(encodedPolyline, strokeColor) {
        const path = google.maps.geometry.encoding.decodePath(encodedPolyline);
        currentPolyline = new google.maps.Polyline({
            path,
            geodesic: true,
            strokeColor,
            strokeOpacity: 0.8,
            strokeWeight: 5
        });
        currentPolyline.setMap(map);

        const bounds = new google.maps.LatLngBounds();
        path.forEach(point => bounds.extend(point));
        map.fitBounds(bounds);
    }

    function saveToHistory(entry) {
        let history = JSON.parse(localStorage.getItem('loopHistory') || '[]');
        history = history.filter(item => item.googleMapsUrl !== entry.googleMapsUrl);
        history.unshift(entry);
        const trimmed = history.slice(0, 5);
        localStorage.setItem('loopHistory', JSON.stringify(trimmed));
        loadHistory();
    }

    function loadHistory() {
        const historyList = document.getElementById('history-list');
        const history = JSON.parse(localStorage.getItem('loopHistory') || '[]');
        
        historyList.innerHTML = '';

        history.forEach((item) => {
            const li = document.createElement('li');
            
            const iconClass = item.mode === 'WALKING' ? 'fa-solid fa-person-walking' : 'fa-solid fa-bicycle';
            const color = item.mode === 'WALKING' ? 'blue' : 'red';

            li.innerHTML = `
                <i class="${iconClass}" style="color: ${color}; width: 20px; text-align: center;"></i> 
                ${item.address} - ${item.distance} km
            `;

            li.addEventListener('click', () => {
                document.getElementById('address').value = item.address === 'Current Location' ? '' : item.address;
                document.getElementById('distance').value = item.distance;
                document.querySelector(`input[name="travel-mode"][value="${item.mode}"]`).checked = true;
                displayRouteFromHistory(item);
            });
            historyList.appendChild(li);
        });
    }

}); // --- End of the DOMContentLoaded listener ---
