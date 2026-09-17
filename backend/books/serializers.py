from rest_framework import serializers
from .models import Book, TrendingBook, Offer


class BookSerializer(serializers.ModelSerializer):
    ebook_price = serializers.ReadOnlyField()
    user_rating = serializers.SerializerMethodField()
    total_reviews = serializers.SerializerMethodField()
    # Explicit CharField: image_url stores relative asset paths ("assets/book-N.jpg")
    # as well as full URLs. Letting DRF auto-derive from URLField would reject them.
    image_url = serializers.CharField(max_length=500, allow_blank=True, required=False)

    class Meta:
        model = Book
        fields = (
            'id', 'title', 'author', 'price', 'ebook_price',
            'category', 'image_url', 'rating', 'reviews_count',
            'is_ebook', 'badge', 'description', 'isbn',
            'stock', 'is_active',
            'user_rating', 'total_reviews',
        )
        # stock and is_active are writable so the admin dashboard can update
        # inventory and visibility; ebook_price, user_rating, total_reviews
        # are read-only computed properties.

    def get_user_rating(self, obj):
        """Aggregate rating including user-submitted reviews."""
        try:
            from reviews.models import Review
            reviews = Review.objects.filter(book=obj)
            if reviews.exists():
                avg = sum(r.rating for r in reviews) / reviews.count()
                return round((float(obj.rating) + avg) / 2, 1)
        except Exception:
            pass
        return float(obj.rating)

    def get_total_reviews(self, obj):
        try:
            from reviews.models import Review
            return obj.reviews_count + Review.objects.filter(book=obj).count()
        except Exception:
            return obj.reviews_count


class TrendingBookSerializer(serializers.ModelSerializer):
    book = BookSerializer(read_only=True)

    class Meta:
        model = TrendingBook
        fields = ('rank', 'book', 'weekly_change', 'is_hot')


class OfferSerializer(serializers.ModelSerializer):
    class Meta:
        model = Offer
        fields = (
            'id', 'gradient_class', 'discount', 'title',
            'description', 'code', 'expiry_label', 'hours_remaining',
        )
