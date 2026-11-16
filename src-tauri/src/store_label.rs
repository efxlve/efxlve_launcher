/** Store label for a library key such as `steam::123` or `epic::Ginger`. */
pub fn store_of(app_name: &str) -> &'static str {
    if app_name.starts_with("steam::") {
        "steam"
    } else if app_name.starts_with("gog::") {
        "gog"
    } else if app_name.starts_with("amazon::") {
        "amazon"
    } else if app_name.starts_with("custom::") {
        "custom"
    } else if app_name.starts_with("ubisoft::") {
        "ubisoft"
    } else if app_name.starts_with("ea::") {
        "ea"
    } else if app_name.starts_with("xbox::") {
        "xbox"
    } else if app_name.starts_with("battlenet::") {
        "battlenet"
    } else if app_name.starts_with("riot::") {
        "riot"
    } else {
        "epic"
    }
}
