// State management
let currentPrefix = '';
let uppyInstance = null;

// Check authentication on page load
async function checkAuth() {
    try {
        const response = await fetch('/api/auth/status');
        const data = await response.json();
        if (data.authenticated) {
            showDashboard();
        } else {
            showLogin();
        }
    } catch (error) {
        console.error('Error checking auth:', error);
        showLogin();
    }
}

// Show/hide screens
function showLogin() {
    document.getElementById('login-screen').style.display = 'block';
    document.getElementById('dashboard-screen').style.display = 'none';
}

function showDashboard() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('dashboard-screen').style.display = 'block';
    loadFiles(currentPrefix);
}

// Login form handler
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('password-input').value;
    const errorDiv = document.getElementById('login-error');
    
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        
        if (response.ok) {
            errorDiv.textContent = '';
            showDashboard();
        } else {
            errorDiv.textContent = 'Invalid password';
        }
    } catch (error) {
        errorDiv.textContent = 'Error logging in';
        console.error('Login error:', error);
    }
});

// Logout handler
document.getElementById('logout-btn').addEventListener('click', async () => {
    try {
        await fetch('/api/logout', { method: 'POST' });
        currentPrefix = '';
        showLogin();
    } catch (error) {
        console.error('Logout error:', error);
    }
});

// Load files from S3
async function loadFiles(prefix = '') {
    const browser = document.getElementById('file-browser');
    browser.innerHTML = '<div class="loading">Loading...</div>';
    
    try {
        const response = await fetch(`/api/objects?prefix=${encodeURIComponent(prefix)}`);
        if (!response.ok) {
            throw new Error('Failed to load files');
        }
        
        const data = await response.json();
        currentPrefix = prefix;
        updateBreadcrumb(prefix);
        renderFiles(data);
    } catch (error) {
        console.error('Error loading files:', error);
        browser.innerHTML = '<div class="empty-state"><p>Error loading files</p></div>';
    }
}

// Update breadcrumb navigation
function updateBreadcrumb(prefix) {
    const breadcrumbPath = document.getElementById('breadcrumb-path');
    if (!prefix) {
        breadcrumbPath.innerHTML = '';
        return;
    }
    
    const parts = prefix.split('/').filter(p => p);
    let html = '';
    let path = '';
    
    parts.forEach((part, index) => {
        path += part + '/';
        html += '<span class="breadcrumb-separator">/</span>';
        html += `<span class="breadcrumb-item" data-path="${path}">${part}</span>`;
    });
    
    breadcrumbPath.innerHTML = html;
    
    // Add click handlers to breadcrumb items
    document.querySelectorAll('.breadcrumb-item').forEach(item => {
        item.addEventListener('click', () => {
            loadFiles(item.dataset.path);
        });
    });
}

// Render files and folders
function renderFiles(data) {
    const browser = document.getElementById('file-browser');
    
    if (data.folders.length === 0 && data.files.length === 0) {
        browser.innerHTML = `
            <div class="empty-state">
                <p>📁 This folder is empty</p>
                <p>Create a folder or upload files to get started</p>
            </div>
        `;
        return;
    }
    
    let html = '<ul class="file-list">';
    
    // Render folders
    data.folders.forEach(folder => {
        html += `
            <li class="file-item folder-item" data-path="${folder.fullPath}">
                <div class="file-icon">📁</div>
                <div class="file-info">
                    <div class="file-name">${escapeHtml(folder.name)}</div>
                    <div class="file-meta">Folder</div>
                </div>
            </li>
        `;
    });
    
    // Render files
    data.files.forEach(file => {
        const size = formatFileSize(file.size);
        const date = new Date(file.lastModified).toLocaleString();
        html += `
            <li class="file-item">
                <div class="file-icon">📄</div>
                <div class="file-info">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-meta">${size} • ${date}</div>
                </div>
            </li>
        `;
    });
    
    html += '</ul>';
    browser.innerHTML = html;
    
    // Add click handlers to folders
    document.querySelectorAll('.folder-item').forEach(item => {
        item.addEventListener('click', () => {
            loadFiles(item.dataset.path);
        });
    });
}

// Utility function to format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Utility function to escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Breadcrumb home click
document.querySelector('.breadcrumb-home').addEventListener('click', () => {
    loadFiles('');
});

// New folder button
document.getElementById('new-folder-btn').addEventListener('click', () => {
    document.getElementById('folder-modal').classList.add('active');
    document.getElementById('folder-name').value = '';
});

// Close folder modal
document.getElementById('close-folder-modal').addEventListener('click', () => {
    document.getElementById('folder-modal').classList.remove('active');
});

document.querySelector('#folder-modal .cancel-btn').addEventListener('click', () => {
    document.getElementById('folder-modal').classList.remove('active');
});

// Create folder
document.getElementById('folder-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const folderName = document.getElementById('folder-name').value.trim();
    
    if (!folderName) return;
    
    const folderPath = currentPrefix + folderName + '/';
    
    try {
        const response = await fetch('/api/folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: folderPath }),
        });
        
        if (response.ok) {
            document.getElementById('folder-modal').classList.remove('active');
            loadFiles(currentPrefix);
        } else {
            alert('Error creating folder');
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        alert('Error creating folder');
    }
});

// Upload button
document.getElementById('upload-btn').addEventListener('click', () => {
    document.getElementById('upload-modal').classList.add('active');
    initUppy();
});

// Close upload modal
document.getElementById('close-upload-modal').addEventListener('click', () => {
    document.getElementById('upload-modal').classList.remove('active');
    if (uppyInstance) {
        uppyInstance.cancelAll();
    }
});

// Initialize Uppy
function initUppy() {
    if (uppyInstance) {
        return; // Already initialized
    }
    
    const Uppy = window.Uppy.Core;
    const Dashboard = window.Uppy.Dashboard;
    const AwsS3 = window.Uppy.AwsS3;
    
    uppyInstance = new Uppy({
        restrictions: {
            maxNumberOfFiles: null,
            allowedFileTypes: null,
        },
        autoProceed: false,
    })
    .use(Dashboard, {
        target: '#uppy-dashboard',
        inline: true,
        height: 400,
        hideUploadButton: false,
        note: 'Upload files to S3. Files are uploaded directly from your browser.',
    })
    .use(AwsS3, {
        shouldUseMultipart: (file) => file.size > 100 * 1024 * 1024, // Use multipart for files > 100MB
        async getUploadParameters(file) {
            // Get presigned URL from server
            const response = await fetch('/api/upload/presign', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: currentPrefix + file.name,
                }),
            });
            
            if (!response.ok) {
                throw new Error('Failed to get upload URL');
            }
            
            const data = await response.json();
            
            return {
                method: 'PUT',
                url: data.url,
                headers: {
                    'Content-Type': file.type,
                },
            };
        },
    });
    
    uppyInstance.on('complete', (result) => {
        console.log('Upload complete:', result);
        if (result.successful.length > 0) {
            setTimeout(() => {
                document.getElementById('upload-modal').classList.remove('active');
                loadFiles(currentPrefix);
            }, 1000);
        }
    });
    
    uppyInstance.on('error', (error) => {
        console.error('Upload error:', error);
    });
}

// Initialize app
checkAuth();
