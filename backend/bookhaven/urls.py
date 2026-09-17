"""BookHaven URL Configuration"""

from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from .health import health_check, root_index

urlpatterns = [
    # Root & Health checks
    path('', root_index, name='root-index'),
    path('api/health/', health_check, name='api-health'),
    path('health/', health_check, name='health'),

    # Admin
    path('admin/', admin.site.urls),

    # API Endpoints
    path('api/auth/', include('users.urls')),
    path('api/books/', include('books.urls')),
    path('api/orders/', include('orders.urls')),
    path('api/reviews/', include('reviews.urls')),
    path('api/admin/', include('bookhaven.admin_urls')),
]

from django.views.static import serve
import os

frontend_dir = os.path.join(settings.BASE_DIR.parent, 'frontend')

urlpatterns += [
    path('admin.html', serve, {'document_root': frontend_dir, 'path': 'admin.html'}),
    path('admin-login.html', serve, {'document_root': frontend_dir, 'path': 'admin-login.html'}),
    path('', serve, {'document_root': frontend_dir, 'path': 'index.html'}),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    # Serve other static files in debug mode
    from django.urls import re_path
    urlpatterns += [
        re_path(r'^(?P<path>.*\.(html|js|css|mp4|jpg|png|svg|ico))$', serve, {'document_root': frontend_dir}),
    ]
