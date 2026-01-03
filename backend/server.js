const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require("express-session");
const dotenv = require('dotenv');
const multer = require('multer');
const http = require('http');

dotenv.config();

// Firebase imports
const {db} = require('./firebase/firebaseConfig');
const {collection, query, where, getDocs, doc, updateDoc, limit, getDoc, addDoc} = require('firebase/firestore');
const {
    createUser, loginUser, forgotPassword, resetPassword,
    isUserAdmin, promoteUserToAdmin, loadAdminEmails, deleteUserAccount,
    ADMIN_EMAILS
} = require('./firebase/authService');

// Import Cloudinary image service
const {uploadProfilePicture} = require('./cloudinary/imageService');

// Utilities
let songData = [];
fs.readFile(path.join(__dirname, '../frontend/public/data/songsData.json'), 'utf8', (err, data) => {
    if (!err) {
        try {
            songData = JSON.parse(data);
            console.log(`Loaded ${songData.length} songs from songsData.json`);
        } catch (parseError) {
            console.error('Error parsing songsData.json:', parseError);
        }
    } else {
        console.warn('Could not load songsData.json, using empty array:', err);
    }
});

const {shuffle} = require('../frontend/public/scripts/utility/shuffle');

// Function to load songs from local files without overwriting
function loadLocalSongs() {
    const dataFilePath = path.join(__dirname, '../frontend/public/data/songsData.json');

    try {
        // Check if songsData.json exists and has content
        if (fs.existsSync(dataFilePath)) {
            const fileContent = fs.readFileSync(dataFilePath, 'utf8');
            try {
                const songData = JSON.parse(fileContent);
                if (songData && Array.isArray(songData) && songData.length > 0) {
                    console.log(`Loaded ${songData.length} songs from existing songsData.json`);
                    return songData;
                }
            } catch (parseError) {
                console.error('Error parsing songsData.json:', parseError);
            }
        }

        // If we couldn't load data from the file, return an empty array
        console.warn('Could not load data from songsData.json');
        return [];
    } catch (error) {
        console.error('Error loading songs:', error);
        return [];
    }
}

/**
 * Retrieves the number of times each song has been played from the 'plays' collection in Firestore.
 * @returns {Promise<Record<string, number>>} - A map where each key is a songId and the value is its play count.
 */
function getPlayCounts() {
    return getDocs(collection(db, 'plays'))
        .then(snapshot => {
            return snapshot.docs.reduce((acc, doc) => {
                const {songId} = doc.data();
                if (songId) acc[songId] = (acc[songId] || 0) + 1;
                return acc;
            }, {});
        })
        .catch(error => {
            console.error('Error fetching play counts:', error);
            throw error;
        });
}

/**
 * Estimates total storage used by all songs in MB based on duration.
 * Assumes approx. 1MB per minute for MP3 files.
 * @returns {Promise<number>} - Total estimated storage used in MB
 */
function getEstimatedStorageUsed() {
    return getDocs(collection(db, 'songs'))
        .then(snapshot =>
            snapshot.docs.reduce((total, doc) => {
                const duration = doc.data().duration || '0:00';
                const [min = 0, sec = 0] = duration.split(':').map(Number);
                return total + (min * 60 + sec) / 60; // 1MB per minute
            }, 0)
        )
        .catch(error => {
            console.error('Error calculating storage usage:', error);
            throw error;
        });
}


const app = express();
const port = 3000;

// Create an HTTP server
const server = http.createServer(app);

// Load songs from the file if they weren't loaded earlier
if (songData.length === 0) {
    try {
        songData = loadLocalSongs();
    } catch (error) {
        console.error('Error loading songs data:', error);
    }
}

// Paths Configuration
const paths = {
    public: path.join(__dirname, "../frontend/public"),
    views: path.join(__dirname, "../frontend/views"),
    data: path.join(__dirname, "../frontend/public/data"),
};

// Middleware Setup
app.use(express.static(paths.public));
app.use(express.json());
app.use(session({
    secret: "your-secret-key",
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: false,
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days in milliseconds
    }
}));

// Debug middleware to log session data
app.use((req, res, next) => {
    if (req.path === '/admin' || req.path.startsWith('/api/admin')) {
        console.log('Session data for admin path:', {
            path: req.path,
            email: req.session.email,
            isAdmin: req.session.isAdmin,
            usernameLetter: req.session.usernameLetter,
        });
    }
    next();
});

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

// View Engine Setup
app.set("view engine", "ejs");
app.set("views", paths.views);

// Helper function to fetch user by email - eliminates duplicate code
async function getUserByEmail(email) {
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('email', '==', email), limit(1));
    const userSnapshot = await getDocs(q);

    if (userSnapshot.empty) {
        return null;
    }

    const userData = userSnapshot.docs[0].data();
    const userId = userSnapshot.docs[0].id; // This is now the readable ID

    return {userData, userId};
}

// Set song data in response locals for rendering
app.use((req, res, next) => {
    // Load album data from albumsData.json for correct album names
    try {
        const albumsDataPath = path.join(paths.data, 'albumsData.json');
        const albumsData = fs.existsSync(albumsDataPath) ?
            JSON.parse(fs.readFileSync(albumsDataPath, 'utf8')) : [];

        // Transform albumsData to have the same structure as songs for compatibility
        const formattedAlbums = albumsData.map(album => ({
            album: album.albumName,
            albumCover: `/assets/album-covers${album.albumCover}`,
            id: album.songs?.[0]?.id || 0
        }));

        res.locals.song = songData.length > 0 ? songData[0] : {}; // Placeholder song data
        res.locals.songRow1 = shuffle([...songData]);
        res.locals.songRow2 = shuffle([...songData]);
        res.locals.albums = shuffle(formattedAlbums);
    } catch (error) {
        console.error('Error loading albums data:', error);
        // Fallback to the old method if there's an error
        const albums = [...new Set(songData.map(song => song.album))];
        const albumData = songData.filter(song => albums.includes(song.album));

        res.locals.song = songData.length > 0 ? songData[0] : {}; // Placeholder song data
        res.locals.songRow1 = shuffle([...songData]);
        res.locals.songRow2 = shuffle([...songData]);
        res.locals.albums = shuffle(albumData);
    }

    next();
});

// Static Routes for EJS Views
const pageRoutes = {
    "/": "SignupPage",
    "/home": "HomePage",
    "/signup": "SignupPage",
    "/login": "LoginPage",
    "/profile": "ProfilePage",
    "/album": "AlbumPage",
    "/reset-password": "ResetPasswordPage",
    "/admin": "AdminPage",
    "/coming-soon": "ComingSoon"  // Add a Coming Soon page to static routes
};

// Search route is handled separately because it needs the query parameter
app.get("/search", async (req, res) => {
    const {usernameLetter, email, isAdmin} = req.session;
    const query = req.query.query || '';

    // Redirect to log in if not authenticated
    if (!usernameLetter) {
        console.log(`Redirecting unauthenticated user from /search to /login`);
        return res.redirect("/login");
    }

    // Get the user's profile picture if logged in
    let profilePicture = null;
    if (email) {
        try {
            const user = await getUserByEmail(email);
            if (user) {
                profilePicture = user.userData.profilePicture || '/assets/profile/default-avatar.jpg';
            }
        } catch (error) {
            console.error('Error fetching profile picture:', error);
            profilePicture = '/assets/profile/default-avatar.jpg';
        }
    }

    res.render("SearchPage", {usernameLetter, profilePicture, isAdmin, query});
});

Object.entries(pageRoutes).forEach(([route, view]) => {
    // Skip the search route as it's handled separately
    if (route === "/search") return;

    app.get(route, async (req, res) => {
        const {usernameLetter, name, email, isAdmin} = req.session;

        // Debugging info to help troubleshoot issues
        if (route === '/admin') {
            console.log('Admin page access attempt:');
            console.log('- Email:', email);
            console.log('- Session isAdmin:', isAdmin);
            if (email) {
                const adminStatus = await isUserAdmin(email);
                console.log('- Current isAdmin status:', adminStatus);

                // Update the session if needed
                if (adminStatus && !isAdmin) {
                    req.session.isAdmin = true;
                    console.log('- Updated session isAdmin to true');
                }
            }
        }

        // Redirect to log in if not authenticated
        if (!usernameLetter && !['/login', '/signup', '/reset-password'].includes(route)) {
            console.log(`Redirecting unauthenticated user from ${route} to /login`);
            return res.redirect("/login");
        }

        // Check for admin access to the admin page
        if (route === '/admin') {
            // Double-check admin status
            if (email && !isAdmin) {
                const adminStatus = await isUserAdmin(email);
                if (adminStatus) {
                    req.session.isAdmin = true;
                } else {
                    console.log('Non-admin user attempted to access admin page. Redirecting to /home');
                    return res.redirect("/home");
                }
            } else if (!email || !isAdmin) {
                console.log('Non-admin user attempted to access admin page. Redirecting to /home');
                return res.redirect("/home");
            }
        }

        // Get the user's profile picture if logged in
        let profilePicture = null;
        if (email) {
            try {
                const user = await getUserByEmail(email);
                if (user) {
                    profilePicture = user.userData.profilePicture || '/assets/profile/default-avatar.jpg';
                }
            } catch (error) {
                console.error('Error fetching profile picture:', error);
                profilePicture = '/assets/profile/default-avatar.jpg';
            }
        }

        // If the route is "/profile", pass user details
        if (route === "/profile") {
            return res.render(view, {username: name, usermail: email, usernameLetter, profilePicture, isAdmin});
        }

        res.render(view, {usernameLetter, profilePicture, isAdmin});
    });
});

// API Routes
app.get("/api/data/:type", (req, res) => {
    const {type} = req.params;
    const allowedFiles = ["profileData", "songsData", "albumsData"];

    if (!allowedFiles.includes(type)) return res.status(404).json({error: "Invalid data request."});

    // For song data, return the in-memory data if available
    if (type === "songsData" && songData.length > 0) {
        return res.json(songData);
    }

    // Otherwise read from the file
    fs.readFile(path.join(paths.data, `${type}.json`), "utf-8", (err, data) => {
        if (err) {
            console.error(`Error reading ${type}.json:`, err);
            return res.status(500).json({error: "Error reading the file."});
        }
        res.json(JSON.parse(data));
    });
});

// Updated to use Firebase Authentication
app.post("/api/register", async (req, res) => {
    const {firstName, lastName, email, password, phoneNumber, username} = req.body;
    try {
        // Create the user with auth service
        await createUser({firstName, lastName, email, password, phoneNumber, username});

        // Set session data to log the user in automatically
        req.session.usernameLetter = email.charAt(0).toUpperCase();
        req.session.email = email;
        req.session.name = `${firstName} ${lastName}`;
        req.session.isAdmin = await isUserAdmin(email);

        res.status(201).json({message: "User registered successfully."});
    } catch (error) {
        res.status(error.code === 11000 ? 400 : 500).json({
            error: error.code === 11000 ? "Email already exists." : "Internal server error."
        });
    }
});

// Updated to use Firebase Authentication
app.post("/api/login", async (req, res) => {
    const {email, password} = req.body;
    try {
        const user = await loginUser(email, password);

        // Double-check admin status
        const adminStatus = await isUserAdmin(email);

        // Set session data
        req.session.usernameLetter = email.charAt(0).toUpperCase();
        req.session.email = email;
        req.session.name = `${user.firstName} ${user.lastName}`;
        req.session.isAdmin = adminStatus;

        res.status(200).json({
            message: "Login successful!",
            isAdmin: adminStatus
        });
    } catch (error) {
        console.error('Login error:', error);
        const isInvalidCredentials = error.message === 'Invalid credentials.';
        const isUserNotFound = error.message === 'User profile not found';

        res.status(isInvalidCredentials || isUserNotFound ? 401 : 500).json({
            message: isInvalidCredentials ? "Invalid credentials." :
                isUserNotFound ? "Email not associated with any account." : "Internal server error."
        });
    }
});

// Updated to use Firebase Authentication
app.post("/api/forgot-password", async (req, res) => {
    const {email} = req.body;
    if (!email) return res.status(400).json({error: "Email is required."});

    try {
        await forgotPassword(email);
        res.status(200).json({message: "Password reset email sent."});
    } catch (error) {
        const isUserNotFound = error.message === 'Email not associated with any account.';
        res.status(isUserNotFound ? 404 : 500).json({
            error: isUserNotFound ? "Email not associated with any account." : "Internal server error."
        });
    }
});

// New endpoint for resetting password with a token
app.post("/api/reset-password", async (req, res) => {
    const {token, password} = req.body;

    if (!token || !password) {
        return res.status(400).json({error: "Token and password are required."});
    }

    try {
        await resetPassword(token, password);
        res.status(200).json({message: "Password reset successful."});
    } catch (error) {
        const isInvalidToken = error.message === 'Invalid or expired token.';
        res.status(isInvalidToken ? 400 : 500).json({
            error: isInvalidToken ? "Invalid or expired token. Please request a new password reset." : "Internal server error."
        });
    }
});

// Add API routes for user profile and favorites
app.get('/api/user/profile', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        // Get user data from Firestore using helper function
        const user = await getUserByEmail(req.session.email);

        if (!user) {
            return res.status(404).json({error: 'User not found'});
        }

        const userData = user.userData;

        res.json({
            firstName: userData.firstName || '',
            lastName: userData.lastName || '',
            email: userData.email,
            username: userData.username || '',
            phoneNumber: userData.phoneNumber || '',
            profilePicture: userData.profilePicture || '/assets/profile/default-avatar.jpg',
            preferences: userData.preferences || {theme: 'light', audioQuality: 'auto'}
        });
    } catch (error) {
        console.error('Error fetching user profile:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Update profile update endpoint to include phone number
app.put('/api/user/profile', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const {firstName, lastName, username, phoneNumber} = req.body;
        const user = await getUserByEmail(req.session.email);

        if (!user) {
            return res.status(404).json({error: 'User not found'});
        }

        const userRef = doc(db, "users", user.userId);

        // Update user data
        await updateDoc(userRef, {
            firstName: firstName || '',
            lastName: lastName || '',
            username: username || '',
            phoneNumber: phoneNumber || ''
        });

        // Update session data
        req.session.name = `${firstName} ${lastName}`;

        res.json({message: 'Profile updated successfully'});
    } catch (error) {
        console.error('Error updating user profile:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Update the profile picture upload endpoint to use Cloudinary
app.post('/api/user/profile-picture', upload.single('profilePicture'), async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        if (!req.file) {
            return res.status(400).json({error: 'No file uploaded'});
        }

        const user = await getUserByEmail(req.session.email);

        if (!user) {
            return res.status(404).json({error: 'User not found'});
        }

        // Upload image to Cloudinary
        const imageURL = await uploadProfilePicture(
            req.file.buffer,
            user.userId,
            req.file.mimetype,
            // Callback to run after a successful Cloudinary upload and Firebase update
            () => {
                console.log('Profile picture updated successfully');
            }
        );

        // Return the Cloudinary URL immediately so the client gets a response
        // Include a refresh flag to indicate the client should reload the page
        res.json({profilePicture: imageURL, shouldRefresh: true});
    } catch (error) {
        console.error('Error updating profile picture:', error);
        res.status(500).json({error: 'Failed to update profile picture'});
    }
});

// Get user preferences
app.get('/api/user/preferences', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const user = await getUserByEmail(req.session.email);

        if (!user) {
            return res.status(404).json({error: 'User not found'});
        }

        // Ensure preferences exist, default to light theme and auto quality if not
        const preferences = user.userData.preferences || {theme: 'light', audioQuality: 'auto'};

        res.json(preferences);
    } catch (error) {
        console.error('Error fetching user preferences:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Update user preferences
app.put('/api/user/preferences', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const preferences = req.body;
        const user = await getUserByEmail(req.session.email);

        if (!user) {
            return res.status(404).json({error: 'User not found'});
        }

        const userRef = doc(db, "users", user.userId);

        // Update preferences
        await updateDoc(userRef, {
            preferences: preferences
        });

        // Log success for debugging
        console.log('Preferences updated successfully:', preferences);

        res.json({message: 'Preferences updated successfully'});
    } catch (error) {
        console.error('Error updating user preferences:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Get user favorites
app.get('/api/user/favorites', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const user = await getUserByEmail(req.session.email);

        if (!user) {
            return res.status(404).json({error: 'User not found'});
        }

        const favorites = user.userData.favorites || [];

        // Log favorites only in development environment
        if (process.env.NODE_ENV !== 'production') {
            console.log('Fetched user favorites:', favorites);
        }

        // If no favorites, return an empty array
        if (favorites.length === 0) {
            return res.json([]);
        }

        // Get song details for favorites - ensure we're comparing strings
        const favoriteTracksData = songData.filter(song => {
            const songIdStr = song.id.toString();
            return favorites.some(favId => favId.toString() === songIdStr);
        });

        // Log match count only in the development environment
        if (process.env.NODE_ENV !== 'production') {
            console.log('Matched favorites with song data:', favoriteTracksData.length, 'songs');
        }

        res.json(favoriteTracksData);
    } catch (error) {
        console.error('Error fetching user favorites:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Helper function to update favorites
async function updateFavorites(email, songId, action) {
    const user = await getUserByEmail(email);
    if (!user) {
        throw new Error('User not found');
    }

    const userDocId = user.userId;
    const userData = user.userData;
    const favorites = (userData.favorites || []).map(id => id.toString());

    let updatedFavorites = favorites;

    if (action === 'add') {
        // Check if a song is already a favorite
        if (favorites.includes(songId)) {
            return {message: 'Song already in favorites'};
        }
        updatedFavorites = [...favorites, songId];
    } else if (action === 'remove') {
        updatedFavorites = favorites.filter(id => id !== songId);
    }

    // Update user document
    const userRef = doc(db, "users", userDocId);
    await updateDoc(userRef, {
        favorites: updatedFavorites
    });

    console.log(`${action === 'add' ? 'Added to' : 'Removed from'} favorites:`, songId);

    return {message: action === 'add' ? 'Song added to favorites' : 'Song removed from favorites'};
}

// Add song to favorites
app.post('/api/user/favorites/:songId', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const songId = req.params.songId.toString(); // Ensure it's a string
        const result = await updateFavorites(req.session.email, songId, 'add');

        // Include a flag indicating to refresh for other clients
        res.json({...result, shouldRefresh: true});
    } catch (error) {
        console.error('Error adding song to favorites:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Remove song from favorites
app.delete('/api/user/favorites/:songId', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const songId = req.params.songId.toString(); // Ensure it's a string
        const result = await updateFavorites(req.session.email, songId, 'remove');

        // Include a flag indicating to refresh for other clients
        res.json({...result, shouldRefresh: true});
    } catch (error) {
        console.error('Error removing song from favorites:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Check if a song is a favorite by the user
app.get('/api/user/check-favorite/:songId', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const songId = req.params.songId.toString();
        const user = await getUserByEmail(req.session.email);

        if (!user) {
            return res.status(404).json({error: 'User not found'});
        }

        const favorites = user.userData.favorites || [];
        const isFavorite = favorites.some(id => id.toString() === songId);

        res.json({isFavorite});
    } catch (error) {
        console.error('Error checking favorite status:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Generic endpoint to check for updates
app.get('/api/user/check-updates', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        // Currently, no specific updates to check
        // In the future, this could check for new content, notifications, etc.
        res.json({
            shouldRefresh: false,
            message: 'No updates available'
        });
    } catch (error) {
        console.error('Error checking for updates:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Add a logout route if it doesn't exist
app.get('/logout', (req, res) => {
    console.log('GET logout route hit, destroying session');
    req.session.destroy(err => {
        if (err) {
            console.error('Error during logout:', err);
        }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.post('/api/logout', (req, res) => {
    console.log('POST logout route hit, destroying session');
    req.session.destroy(err => {
        if (err) {
            console.error('Error during logout:', err);
            return res.status(500).json({error: 'Internal server error'});
        }
        res.clearCookie('connect.sid');
        res.status(200).json({message: 'Logged out successfully'});
    });
});

// Admin API Routes

// Middleware to check if the user is admin
const adminMiddleware = async (req, res, next) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    if (!req.session.isAdmin) {
        // Double-check in case the session is out of date
        const adminStatus = await isUserAdmin(req.session.email);
        if (!adminStatus) {
            return res.status(403).json({error: 'Forbidden: Admin access required'});
        }
        // Update session if admin status has changed
        req.session.isAdmin = true;
    }

    next();
};

// Get system stats for the admin dashboard
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
    try {
        // Get total songs count
        const totalSongs = songData.length;

        // Get total users count
        const usersRef = collection(db, 'users');
        const usersSnapshot = await getDocs(usersRef);
        const totalUsers = usersSnapshot.size;

        let playCountMap = await getPlayCounts();

        // Update song data with play counts
        songData.forEach(song => {
            song.playCount = playCountMap[song.id] || 0;
        });

        // Get top 5 played songs with real play counts
        const topPlayedSongs = [...songData]
            .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
            .slice(0, 5)
            .map(song => ({
                id: song.id,
                title: song.title,
                artist: Array.isArray(song.artist) ? song.artist.join(', ') : song.artist,
                playCount: song.playCount || 0
            }));

        // Calculate storage usage
        let totalStorageUsed = getEstimatedStorageUsed();

        // Format storage values
        const storageUsed = {
            total: "1 GB",
            used: `${Math.round(totalStorageUsed)} MB`,
            percentage: Math.round((totalStorageUsed / 1024) * 100) // Assuming 1GB total
        };

        // Get recent activity from the database - combine various activities
        const activityList = [];

        // Get recent plays
        const recentPlaysRef = collection(db, 'plays');
        const recentPlaysQuery = query(recentPlaysRef, limit(5));
        const recentPlaysSnapshot = await getDocs(recentPlaysQuery);

        recentPlaysSnapshot.forEach(doc => {
            const data = doc.data();
            const song = songData.find(s => s.id === data.songId);

            if (song) {
                activityList.push({
                    type: 'play',
                    user: data.userEmail || 'Anonymous User',
                    item: song.title,
                    timestamp: data.timestamp || new Date().toISOString()
                });
            }
        });

        // Get recent likes
        const recentLikesRef = collection(db, 'likes');
        const recentLikesQuery = query(recentLikesRef, limit(5));
        const recentLikesSnapshot = await getDocs(recentLikesQuery);

        recentLikesSnapshot.forEach(doc => {
            const data = doc.data();
            const song = songData.find(s => s.id === data.songId);

            if (song) {
                activityList.push({
                    type: 'like',
                    user: data.userEmail || 'Anonymous User',
                    item: song.title,
                    timestamp: data.timestamp || new Date().toISOString()
                });
            }
        });

        // Sort activities by timestamp
        const recentActivity = activityList
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 10);

        // If no real activity, create sample data based on songs
        if (recentActivity.length === 0) {
            // Get up to 5 songs for sample data
            const sampleSongs = songData.slice(0, 5);

            // Create sample users
            const users = [];
            usersSnapshot.forEach(doc => {
                const userData = doc.data();
                users.push(userData.email);
            });

            // Create a sample activity if we have songs and users
            if (sampleSongs.length > 0) {
                const now = new Date();

                for (let i = 0; i < sampleSongs.length; i++) {
                    const song = sampleSongs[i];
                    const user = users[i % users.length] || 'user@example.com';

                    // Add play activity
                    recentActivity.push({
                        type: 'play',
                        user: user,
                        item: song.title,
                        timestamp: new Date(now - i * 3600000).toISOString() // 1 hour apart
                    });

                    // Add like activity for some songs
                    if (i % 2 === 0) {
                        recentActivity.push({
                            type: 'like',
                            user: user,
                            item: song.title,
                            timestamp: new Date(now - (i * 3600000 + 1800000)).toISOString() // 30 min after play
                        });
                    }
                }
            }
        }

        res.json({
            totalSongs,
            totalUsers,
            topPlayedSongs,
            storageUsed,
            recentActivity
        });
    } catch (error) {
        console.error('Error fetching admin stats:', error);
        res.status(500).json({error: 'Failed to fetch admin statistics'});
    }
});

// Get all users for admin management
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        const usersRef = collection(db, 'users');
        const usersSnapshot = await getDocs(usersRef);

        const users = [];
        usersSnapshot.forEach(doc => {
            const userData = doc.data();
            users.push({
                id: doc.id,
                email: userData.email,
                name: `${userData.firstName || ''} ${userData.lastName || ''}`.trim(),
                username: userData.username || '',
                isAdmin: userData.isAdmin || false,
                profilePicture: userData.profilePicture || '/assets/profile/default-avatar.jpg',
                createdAt: userData.createdAt
            });
        });

        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({error: 'Failed to fetch users'});
    }
});

// Create a new user from the admin panel
app.post('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        const {username, email, password, role} = req.body;

        // Validate required fields
        if (!email || !password || !username) {
            return res.status(400).json({error: 'Email, password and username are required'});
        }

        // Create a user with basic information
        const userData = {
            firstName: username.split(' ')[0] || '',
            lastName: username.split(' ').slice(1).join(' ') || '',
            email,
            password,
            username
        };

        // Create the user with Firebase Auth
        const user = await createUser(userData);

        // If the role is admin, promote the user to admin
        if (role === 'admin') {
            await promoteUserToAdmin(email, req.session.email);
        }

        res.status(201).json({
            message: 'User created successfully',
            id: user.uid
        });
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(error.code === 'auth/email-already-exists' ? 400 : 500)
            .json({error: error.message || 'Failed to create user'});
    }
});

// Get a single user by ID for editing
app.get('/api/admin/users/:userId', adminMiddleware, async (req, res) => {
    try {
        const userId = req.params.userId;
        // userId is now a readable ID, so we can directly access it
        const userDoc = await getDoc(doc(db, 'users', userId));

        if (!userDoc.exists()) {
            return res.status(404).json({error: 'User not found'});
        }

        const userData = userDoc.data();

        res.json({
            id: userDoc.id, // This is the readable ID
            authUid: userData.authUid, // Include the Firebase Auth UID
            email: userData.email,
            username: userData.username || '',
            role: userData.isAdmin ? 'admin' : 'user',
            profilePicture: userData.profilePicture || '/assets/profile/default-avatar.jpg',
            createdAt: userData.createdAt
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({error: 'Failed to fetch user'});
    }
});

// Update a user
app.put('/api/admin/users/:userId', adminMiddleware, async (req, res) => {
    try {
        const userId = req.params.userId;
        const {username, email, role} = req.body;

        // userId is now a readable ID
        const userDoc = await getDoc(doc(db, 'users', userId));

        if (!userDoc.exists()) {
            return res.status(404).json({error: 'User not found'});
        }

        const userData = userDoc.data();
        const wasAdmin = userData.isAdmin;
        const willBeAdmin = role === 'admin';

        // Update the user data - userId is the readable ID
        await updateDoc(doc(db, 'users', userId), {
            username: username || '',
            email: email || userData.email,
            isAdmin: willBeAdmin
        });

        // If changing to the admin role, update ADMIN_EMAILS
        if (!wasAdmin && willBeAdmin && !ADMIN_EMAILS.includes(email)) {
            ADMIN_EMAILS.push(email);
        }

        res.json({message: 'User updated successfully'});
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({error: 'Failed to update user'});
    }
});

// Delete a user
app.delete('/api/admin/users/:userId', adminMiddleware, async (req, res) => {
    // Note: This is a stub - Firebase doesn't directly support deleting users from client SDK
    // In a real application, you would need to use Firebase Admin SDK or Cloud Functions
    res.status(501).json({error: 'User deletion not implemented yet'});
});

// Promote user to admin
app.post('/api/admin/promote-user', adminMiddleware, async (req, res) => {
    try {
        const {userEmail} = req.body;

        if (!userEmail) {
            return res.status(400).json({error: 'User email is required'});
        }

        const result = await promoteUserToAdmin(userEmail, req.session.email);
        res.json(result);
    } catch (error) {
        console.error('Error promoting user:', error);
        res.status(error.message.includes('Unauthorized') ? 403 : 500)
            .json({error: error.message || 'Failed to promote user'});
    }
});

// Get all songs for admin management
app.get('/api/admin/songs', adminMiddleware, async (req, res) => {
    try {
        let playCountMap = await getPlayCounts();

        // Update song data with play counts
        const songsWithPlayCounts = songData.map(song => ({
            ...song,
            playCount: playCountMap[song.id] || 0
        }));

        res.json(songsWithPlayCounts);
    } catch (error) {
        console.error('Error fetching songs:', error);
        res.status(500).json({error: 'Failed to fetch songs'});
    }
});

// Get all artists for admin management
app.get('/api/admin/artists', adminMiddleware, async (req, res) => {
    try {
        // Extract unique artists from song data
        const artistMap = {};

        songData.forEach(song => {
            if (Array.isArray(song.artist)) {
                song.artist.forEach(artistName => {
                    if (!artistMap[artistName]) {
                        artistMap[artistName] = {
                            id: artistName.toLowerCase().replace(/\s+/g, '-'),
                            name: artistName,
                            songs: [],
                            albums: new Set()
                        };
                    }

                    // Add song to artist's songs
                    artistMap[artistName].songs.push(song.id);

                    // Add album to artist's albums
                    if (song.album) {
                        artistMap[artistName].albums.add(song.album);
                    }
                });
            }
        });

        // Convert to array and convert album sets to arrays
        const artists = Object.values(artistMap).map(artist => ({
            ...artist,
            albums: Array.from(artist.albums)
        }));

        res.json(artists);
    } catch (error) {
        console.error('Error fetching artists:', error);
        res.status(500).json({error: 'Failed to fetch artists'});
    }
});

// Get all albums for admin management
app.get('/api/admin/albums', adminMiddleware, async (req, res) => {
    try {
        // Read albums' data from the JSON file
        const albumsDataPath = path.join(paths.data, 'albumsData.json');

        if (!fs.existsSync(albumsDataPath)) {
            return res.json([]);
        }

        const albumsData = JSON.parse(fs.readFileSync(albumsDataPath, 'utf8'));

        // Format albums for admin panel
        const albums = albumsData.map(album => {
            // Get the primary artist from the first song or use a default
            const primaryArtist = album.songs && album.songs[0] && album.songs[0].artist && album.songs[0].artist[0]
                ? album.songs[0].artist[0]
                : 'Unknown Artist';

            return {
                id: album.albumName.toLowerCase().replace(/\s+/g, '-'),
                title: album.albumName,
                artist: primaryArtist,
                artistId: primaryArtist.toLowerCase().replace(/\s+/g, '-'),
                albumCover: album.albumCover,
                songs: album.songs || [],
                year: album.year || new Date().getFullYear() // Default to the current year if not specified
            };
        });

        res.json(albums);
    } catch (error) {
        console.error('Error fetching albums:', error);
        res.status(500).json({error: 'Failed to fetch albums'});
    }
});

// Upload a new song (placeholder)
app.post('/api/admin/songs/upload', adminMiddleware, upload.single('songFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({error: 'No file uploaded'});
        }

        // Placeholder response - actual implementation would save the file and update DB
        res.json({
            message: 'Song upload placeholder - implementation pending',
            filename: req.file.originalname
        });
    } catch (error) {
        console.error('Error uploading song:', error);
        res.status(500).json({error: 'Failed to upload song'});
    }
});

// Update song metadata
app.put('/api/admin/songs/:songId', adminMiddleware, async (req, res) => {
    try {
        const {songId} = req.params;
        const {title, artist, album, genre} = req.body;

        // Find the song in the array
        const songIndex = songData.findIndex(song => song.id.toString() === songId.toString());

        if (songIndex === -1) {
            return res.status(404).json({error: 'Song not found'});
        }

        // Update the song in memory
        songData[songIndex] = {
            ...songData[songIndex],
            title: title || songData[songIndex].title,
            artist: artist || songData[songIndex].artist,
            album: album || songData[songIndex].album,
            genre: genre || songData[songIndex].genre
        };

        // Write the updated data to the JSON file
        fs.writeFileSync(
            path.join(__dirname, '../frontend/public/data/songsData.json'),
            JSON.stringify(songData, null, 2)
        );

        res.json({
            message: 'Song updated successfully',
            song: songData[songIndex]
        });
    } catch (error) {
        console.error('Error updating song:', error);
        res.status(500).json({error: 'Failed to update song'});
    }
});

// Delete song
app.delete('/api/admin/songs/:songId', adminMiddleware, async (req, res) => {
    try {
        const {songId} = req.params;

        // Find the song in the array
        const songIndex = songData.findIndex(song => song.id.toString() === songId.toString());

        if (songIndex === -1) {
            return res.status(404).json({error: 'Song not found'});
        }

        // Remove the song from memory
        const removedSong = songData.splice(songIndex, 1)[0];

        // Write the updated data to the JSON file
        fs.writeFileSync(
            path.join(__dirname, '../frontend/public/data/songsData.json'),
            JSON.stringify(songData, null, 2)
        );

        res.json({
            message: 'Song deleted successfully',
            song: removedSong
        });
    } catch (error) {
        console.error('Error deleting song:', error);
        res.status(500).json({error: 'Failed to delete song'});
    }
});

// Get all storage usage
app.get('/api/admin/storage', adminMiddleware, async (req, res) => {
    try {
        // Calculate storage usage from song data
        let totalStorageUsed = getEstimatedStorageUsed();

        // Calculate total size for images (album covers)
        const uniqueAlbums = [...new Set(songData.map(song => song.album))];
        const estimatedImageSizeMB = uniqueAlbums.length * 2; // Approx 2MB per image

        // Add total image size to storage used
        totalStorageUsed += estimatedImageSizeMB;

        // Format response with the correct structure expected by the frontend
        const totalStorageGB = 5; // 5GB total storage limit
        const availableStorageGB = totalStorageGB - (totalStorageUsed / 1024);

        // Generate file data based on songs and albums
        const files = [];

        // Add song files
        songData.slice(0, 10).forEach(song => {
            // Calculate estimated size based on duration
            const durationParts = (song.duration || '0:00').split(':');
            const minutes = parseInt(durationParts[0]) || 0;
            const seconds = parseInt(durationParts[1]) || 0;
            const totalSeconds = minutes * 60 + seconds;
            const estimatedSizeMB = Math.max(1, totalSeconds / 60);

            files.push({
                name: `${song.title.replace(/\s+/g, '_')}.mp3`,
                size: estimatedSizeMB * 1024 * 1024, // Size in bytes
                type: 'audio/mpeg',
                url: song.file || `/songs/${song.id}.mp3`,
                uploadedAt: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString() // Random date within the last 30 days
            });
        });

        // Add album covers
        const uniqueAlbumCovers = [...new Set(songData.map(song => song.albumCover))];
        uniqueAlbumCovers.slice(0, 5).forEach(cover => {
            if (cover) {
                const filename = cover.split('/').pop();
                files.push({
                    name: filename || 'album-cover.jpg',
                    size: 2 * 1024 * 1024, // 2MB
                    type: 'image/jpeg',
                    url: cover,
                    uploadedAt: new Date(Date.now() - Math.random() * 60 * 24 * 60 * 60 * 1000).toISOString() // Random date within the last 60 days
                });
            }
        });

        res.json({
            stats: {
                total: `${totalStorageGB} GB`,
                used: `${Math.round(totalStorageUsed)} MB`,
                available: `${availableStorageGB.toFixed(2)} GB`,
                percentage: Math.round((totalStorageUsed / (totalStorageGB * 1024)) * 100)
            },
            files: files
        });
    } catch (error) {
        console.error('Error fetching storage info:', error);
        res.status(500).json({error: 'Failed to fetch storage information'});
    }
});

// Upload the file to storage
app.post('/api/admin/storage/upload', adminMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({error: 'No file uploaded'});
        }

        // Get the file path from form data
        const filePath = req.body.path || 'uploads';

        // In a real implementation, you would save this file to your storage system
        // For now; this is a placeholder that simulates a successful upload

        // Mock successful response
        res.status(200).json({
            success: true,
            file: {
                name: req.file.originalname,
                size: req.file.size,
                type: req.file.mimetype,
                url: `/uploads/${filePath}/${req.file.originalname}`,
                uploadedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('Error uploading file:', error);
        res.status(500).json({error: 'Failed to upload file'});
    }
});

// Delete the file from storage
app.delete('/api/admin/storage/delete', adminMiddleware, async (req, res) => {
    try {
        const {fileUrl} = req.body;

        if (!fileUrl) {
            return res.status(400).json({error: 'File URL is required'});
        }

        // In a real implementation, you would delete the file from your storage system
        // For now; this is a placeholder that simulates a successful deletion

        // Mock successful response
        res.status(200).json({
            success: true,
            message: 'File deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({error: 'Failed to delete file'});
    }
});

// Initialize admin data
(async function () {
    try {
        await loadAdminEmails();
        console.log('Admin data initialized successfully');
    } catch (error) {
        console.error('Error initializing admin data:', error);
    }
})();

// Add a specific route for the admin page to ensure it works
app.get('/admin', async (req, res) => {
    console.log('Admin page access attempt');

    // If not logged in, redirect to log in
    if (!req.session.email) {
        console.log('Not logged in, redirecting to login');
        return res.redirect('/login');
    }

    // Check admin status directly
    const isAdmin = await isUserAdmin(req.session.email);
    console.log(`Admin status for ${req.session.email}: ${isAdmin}`);

    if (!isAdmin) {
        console.log('Not an admin, redirecting to home');
        return res.redirect('/home');
    }

    // Update session
    req.session.isAdmin = true;

    // Get user data
    let userData = {
        username: req.session.name || req.session.email.split('@')[0],
        email: req.session.email,
        profilePicture: '/assets/profile/default-avatar.jpg'
    };

    try {
        const user = await getUserByEmail(req.session.email);
        if (user) {
            userData.profilePicture = user.userData.profilePicture || '/assets/profile/default-avatar.jpg';
            userData.username = user.userData.username || req.session.name || req.session.email.split('@')[0];
        }
    } catch (error) {
        console.error('Error fetching user data:', error);
    }

    // Render the admin page
    res.render('AdminPage', {
        usernameLetter: req.session.usernameLetter,
        profilePicture: userData.profilePicture,
        isAdmin: true,
        user: userData
    });
});

// Admin section routes
app.get('/admin/sections/:section', async (req, res) => {
    // Check if admin
    if (!req.session.isAdmin) {
        return res.status(403).send('Access denied');
    }

    const section = req.params.section;
    const allowedSections = ['dashboard', 'users', 'songs', 'artists', 'storage', 'analytics'];

    if (!allowedSections.includes(section)) {
        return res.status(404).send('Section not found');
    }

    try {
        res.render(`admin/sections/${section}`, {
            user: {
                username: req.session.name || req.session.email.split('@')[0]
            }
        });
    } catch (error) {
        console.error(`Error rendering admin section ${section}:`, error);
        res.status(500).send(`<div class="admin-error">Error loading section</div>`);
    }
});

// Save user preferences
app.post('/api/user/preferences', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const userId = req.session.userId || (await getUserByEmail(req.session.email))?.userId;
        if (!userId) {
            return res.status(404).json({error: 'User not found'});
        }

        const {theme, audioQuality} = req.body;

        // Get current user document
        const userRef = doc(db, 'users', userId);
        const userDoc = await getDoc(userRef);

        if (!userDoc.exists()) {
            return res.status(404).json({error: 'User not found'});
        }

        // Get current preferences
        const userData = userDoc.data();
        const currentPrefs = userData.preferences || {};

        // Update only the provided preferences
        const updatedPrefs = {
            ...currentPrefs,
            ...(theme !== undefined && {theme}),
            ...(audioQuality !== undefined && {audioQuality})
        };

        // Save updated preferences
        await updateDoc(userRef, {preferences: updatedPrefs});

        res.status(200).json({
            message: 'Preferences updated successfully',
            preferences: updatedPrefs
        });
    } catch (error) {
        console.error('Error updating preferences:', error);
        res.status(500).json({error: 'Failed to update preferences'});
    }
});

// Add search API endpoint
app.get('/api/search', (req, res) => {
    const query = req.query.q?.toLowerCase() || '';

    if (!query || query.trim() === '') {
        return res.json({
            songs: [],
            artists: [],
            albums: []
        });
    }

    // Search through songs
    const matchedSongs = songData.filter(song => {
        return (
            song.title.toLowerCase().includes(query) ||
            song.artist.some(artist => artist.toLowerCase().includes(query)) ||
            song.album.toLowerCase().includes(query)
        );
    });

    // Extract unique artists from matched songs
    const artists = [...new Set(
        matchedSongs.flatMap(song => song.artist)
            .filter(artist => artist.toLowerCase().includes(query))
    )];

    // Extract unique albums from matched songs
    const albums = [...new Set(
        matchedSongs
            .filter(song => song.album.toLowerCase().includes(query))
            .map(song => song.album)
    )];

    res.json({
        songs: matchedSongs,
        artists,
        albums
    });
});

// Delete the user account
app.post('/api/user/delete-account', async (req, res) => {
    if (!req.session.email) {
        return res.status(401).json({error: 'Unauthorized'});
    }

    try {
        const {password} = req.body;

        if (!password) {
            return res.status(400).json({error: 'Password is required'});
        }

        // Call the deleteUserAccount function from authService
        await deleteUserAccount(req.session.email, password);

        // Destroy the session
        req.session.destroy(err => {
            if (err) {
                console.error('Error destroying session:', err);
            }

            res.clearCookie('connect.sid');
            res.status(200).json({message: 'Account deleted successfully'});
        });
    } catch (error) {
        console.error('Error deleting account:', error);
        res.status(400).json({error: error.message || 'Failed to delete account'});
    }
});

// Track a song play in Firestore
app.post('/api/songs/track-play', async (req, res) => {
    try {
        const {songId} = req.body;
        if (!songId) {
            return res.status(400).json({error: 'Song ID is required'});
        }

        // Get user information if logged in
        const userEmail = req.session.email || 'Anonymous User';

        // Record the play in the 'plays' collection
        const playsRef = collection(db, 'plays');
        await addDoc(playsRef, {
            songId: songId,
            userEmail: userEmail,
            timestamp: new Date().toISOString()
        });

        res.status(200).json({success: true});
    } catch (error) {
        console.error('Error tracking song play:', error);
        res.status(500).json({error: 'Failed to track song play'});
    }
});

// 404 Error Handling
app.use((req, res) => {
    res.status(404).send(`<h1>404—Page Not Found</h1><p>The page you're looking for doesn't exist.</p><a href="/">Go back to the homepage</a>`);
});

// Start the Server
server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});
