"""Compatibility facade for public handlers while `main` owns route matching."""

from api.front.assets import (
    frontend_redirect,
    media_image_response,
    print_response,
    public_image_response,
    shop_image_response,
    site_image_response,
    wants_json,
)
from api.front.bio_link import avatar_response as bio_link_avatar_response
from api.front.bio_link import calendar_response as bio_link_calendar_response
from api.front.bio_link import redirect_response as bio_link_redirect_response
from api.front.bio_link import response as bio_link_response
from api.front.checkout import (
    cart_validate_response,
    checkout_response,
    fake_payment_response,
    order_response,
    profile_response,
    update_profile_response,
)
from api.front.pages import (
    category_index_response,
    category_page_response,
    page_response,
    preview_response,
    shop_index_response,
    shop_product_response,
    site_response,
)
